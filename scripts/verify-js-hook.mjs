// 回放端「JS Hook 探针(jsHooks)」端到端自检。
// 验证向页面主世界注入 hook 脚本 + exposeBinding 回传后,能抓到全部基础集 + 自定义签名函数:
//   ① fetch(发出前 url/method/body)  ② XMLHttpRequest(open/send)  ③ JSON.stringify(明文对象→串)
//   ④ btoa(base64 前后)  ⑤ crypto.subtle.digest(异步,明文末参)  ⑥ CryptoJS.HmacSHA256(惰性包裹)
//   ⑦ 自定义签名函数 window.mySign(hookPaths 惰性包裹)——每类的「明文入参 ↔ 密文出参 + 调用栈」
// 并验证:短值内联 / 超 maxInline 的大 payload 旁落独立文件(完整不截断);jsHooks 独立于改写总闸
//        (enabled:false 仍抓);jsHooks.enabled:false 时注入但不落盘;maxEntries 达上限熔断(防爆)。
//
// 用法:MACRO_HEADLESS=1 node scripts/verify-js-hook.mjs
//   本机缺 headless_shell 时:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright MACRO_HEADLESS=1 node ...
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// 页面明文:{a,b,big};big 长度由 query 决定,用来切内联 / 旁落。键顺序固定,Node 侧可复现同一字符串。
function plaintextFor(bigLen) {
    return JSON.stringify({ a: 1, b: 'hello', big: 'B'.repeat(bigLen) });
}
// btoa 只处理 latin1;明文纯 ASCII,故等价于 base64(utf8)
function b64(s) {
    return Buffer.from(s, 'utf-8').toString('base64');
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        const u = new URL(req.url, 'http://x');
        const bigLen = Number(u.searchParams.get('big') || '4');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // 页面脚本依次触发 7 类 hook。注入脚本已在 document-start 装好惰性 setter,故 mySign / CryptoJS
        // 的赋值即被包裹。subtle.digest 异步,与 fetch 一并 Promise.all 完成后再插可见的 #done。
        res.end(`<!doctype html><meta charset="utf-8"><title>js-hook</title><div id="host">初始化…</div>
<script>
(function(){
  try {
    window.mySign = function(x){ return btoa(x); };
    window.CryptoJS = { HmacSHA256: function(msg, key){ return 'HMAC_' + msg; } };
    var plain = JSON.stringify({a:1, b:'hello', big:'B'.repeat(${bigLen})});
    var sig = window.mySign(plain);
    window.CryptoJS.HmacSHA256(plain, 'secret');
    var x = new XMLHttpRequest();
    x.open('POST', '/api/echo?via=xhr');
    x.send('xhrbody-' + plain);
    Promise.all([
      crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain)),
      fetch('/api/echo?sign=' + encodeURIComponent(sig), { method:'POST', body: plain }).then(function(r){ return r.text(); })
    ]).then(function(){ var d=document.createElement('div'); d.id='done'; d.textContent='往返完成'; document.body.appendChild(d); })
      .catch(function(e){ var f=document.createElement('div'); f.id='failed'; f.textContent=String(e); document.body.appendChild(f); });
  } catch(e){ var f=document.createElement('div'); f.id='failed'; f.textContent=String(e); document.body.appendChild(f); }
})();
</script>`);
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/echo')) {
        req.on('data', () => {});
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
        });
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`本地服务已启动:http://127.0.0.1:${port}/`);

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed += 1;
    }
}

function loadIndex(dumpsDir) {
    const idxFiles = fs
        .readdirSync(dumpsDir)
        .filter((f) => f.startsWith('jshook-index-') && f.endsWith('.jsonl'));
    const entries = idxFiles.flatMap((f) =>
        fs
            .readFileSync(path.join(dumpsDir, f), 'utf-8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l))
    );
    return { idxFiles, entries };
}

// 读一个 hook 字段(内联则直接取;旁落则从文件读),base64 字段解码回原文
function readField(dumpsDir, entry, kind) {
    const inlineKey = kind === 'in' ? 'input' : 'output';
    const encKey = kind === 'in' ? 'inputEnc' : 'outputEnc';
    const fileKey = kind === 'in' ? 'inputFile' : 'outputFile';
    if (entry[inlineKey] !== undefined) {
        return entry[encKey] === 'base64'
            ? Buffer.from(entry[inlineKey], 'base64').toString('utf-8')
            : entry[inlineKey];
    }
    if (entry[fileKey]) {
        return fs.readFileSync(path.join(dumpsDir, entry[fileKey])).toString('utf-8');
    }
    return undefined;
}

function cleanup(dumpsDir, timelinesDir) {
    try {
        fs.rmSync(dumpsDir, { recursive: true, force: true });
        fs.rmSync(timelinesDir, { recursive: true, force: true });
    } catch {
        /* 忽略 */
    }
}

const ALL_APIS = ['fetch', 'xhr', 'json', 'btoa', 'subtle', 'cryptojs'];

// 跑一种配置:jsEnabled=jsHooks.enabled;bigLen=页面 big 长度;maxInline=内联阈值;maxEntries=可选上限。
async function runCase(label, jsEnabled, bigLen, maxInline, maxEntries) {
    const dumpsDir = fs.mkdtempSync(path.join(os.tmpdir(), `macro-jshook-${label}-`));
    const timelinesDir = fs.mkdtempSync(path.join(os.tmpdir(), `macro-jshook-tl-${label}-`));
    fs.mkdirSync(path.join(root, 'errors'), { recursive: true });
    const jsHooks = {
        enabled: jsEnabled,
        rules: [{ urlPattern: '*', apis: ALL_APIS, hookPaths: ['mySign'], maxInline }],
    };
    if (maxEntries !== undefined) {
        jsHooks.maxEntries = maxEntries;
    }
    const sessionOptions = {
        requestRules: { enabled: false, rules: [], jsHooks }, // enabled:false 证独立于总闸
    };
    const runner = new MacroRunner(
        path.join(root, 'errors'),
        undefined,
        undefined,
        sessionOptions,
        undefined,
        timelinesDir,
        dumpsDir // 第 7 参:落盘目录(jsHook 索引 + 旁落文件)
    );
    const macro = {
        name: `js-hook-${label}`,
        version: 1,
        steps: [
            { type: 'goto', url: `http://127.0.0.1:${port}/?big=${bigLen}` },
            { type: 'waitForSelector', selector: '#done', timeout: 15000 },
        ],
    };
    let result;
    try {
        result = await Promise.race([
            runner.run(macro),
            new Promise((_, reject) => setTimeout(() => reject(new Error('自检硬超时(30s)')), 30000)),
        ]);
    } catch (err) {
        console.error(`\n[${label}] ❌ 回放异常:`, err.message);
        failed += 1;
        return;
    }
    await new Promise((r) => setTimeout(r, 400)); // 给异步 subtle + exposeBinding 回调落盘留余量

    const { idxFiles, entries } = loadIndex(dumpsDir);
    const apis = entries.map((e) => e.api);
    console.log(`\n[${label}] result.ok=${result && result.ok},索引条数=${entries.length},apis=`, apis);
    assert(result && result.ok === true, `[${label}] 回放成功`);

    const expectedPlain = plaintextFor(bigLen);
    const expectedSig = b64(expectedPlain);

    if (!jsEnabled) {
        assert(idxFiles.length === 0, `[${label}] jsHooks.enabled:false 时不生成索引(注入但不落盘)`);
        cleanup(dumpsDir, timelinesDir);
        return;
    }

    if (maxEntries !== undefined) {
        // 防爆:一次页面触发 7 类 hook,配 maxEntries 应恰好熔断在上限
        assert(entries.length === maxEntries, `[${label}] 命中达 maxEntries=${maxEntries} 即熔断(实际 ${entries.length})`);
        cleanup(dumpsDir, timelinesDir);
        return;
    }

    assert(idxFiles.length === 1, `[${label}] 恰好生成 1 个索引文件(实际 ${idxFiles.length})`);
    // 七类 hook 全覆盖
    assert(apis.includes('fetch'), `[${label}] 抓到 fetch`);
    assert(apis.includes('xhr'), `[${label}] 抓到 XMLHttpRequest`);
    assert(apis.includes('json'), `[${label}] 抓到 JSON.stringify`);
    assert(apis.includes('btoa'), `[${label}] 抓到 btoa`);
    assert(apis.includes('subtle.digest'), `[${label}] 抓到 crypto.subtle.digest`);
    assert(apis.includes('cryptojs.HmacSHA256'), `[${label}] 抓到 CryptoJS.HmacSHA256`);
    assert(apis.includes('custom:mySign'), `[${label}] 抓到自定义签名函数 custom:mySign`);

    // 自定义签名函数:明文↔密文↔栈
    const sign = entries.find((e) => e.api === 'custom:mySign');
    if (sign) {
        assert(typeof sign.stack === 'string' && sign.stack.length > 0, `[${label}] custom:mySign 带非空调用栈(可定位函数)`);
        assert(readField(dumpsDir, sign, 'in') === expectedPlain, `[${label}] mySign 明文入参正确(${expectedPlain.length} 字节)`);
        assert(readField(dumpsDir, sign, 'out') === expectedSig, `[${label}] mySign 密文出参正确(= btoa(明文))`);
        const inlined = sign.input !== undefined;
        if (Buffer.byteLength(expectedPlain, 'utf-8') > maxInline) {
            assert(!inlined && !!sign.inputFile, `[${label}] 明文超 maxInline(${maxInline})→ 旁落文件(${sign.inputFile})`);
        } else {
            assert(inlined && !sign.inputFile, `[${label}] 明文未超 maxInline → 内联进索引`);
        }
    }

    // CryptoJS:明文↔密文
    const cj = entries.find((e) => e.api === 'cryptojs.HmacSHA256');
    if (cj) {
        assert(readField(dumpsDir, cj, 'in') === expectedPlain, `[${label}] CryptoJS 明文入参正确`);
        assert(readField(dumpsDir, cj, 'out') === 'HMAC_' + expectedPlain, `[${label}] CryptoJS 出参正确`);
    }

    // XHR:抓到 url+method+body
    const xhr = entries.find((e) => e.api === 'xhr');
    if (xhr) {
        const inp = readField(dumpsDir, xhr, 'in') || '';
        assert(inp.includes('/api/echo') && inp.includes('POST') && inp.includes('xhrbody-'), `[${label}] XHR 记录含 url/method/body`);
    }

    // subtle.digest:出参应为二进制(base64)摘要
    const sd = entries.find((e) => e.api === 'subtle.digest');
    if (sd) {
        const hasOut = sd.output !== undefined || !!sd.outputFile;
        assert(hasOut, `[${label}] subtle.digest 抓到摘要出参`);
    }

    // fetch:抓到 url(带 sign)+method
    const fx = entries.find((e) => e.api === 'fetch');
    if (fx) {
        const inp = readField(dumpsDir, fx, 'in') || '';
        assert(inp.includes('/api/echo') && inp.includes('sign=') && inp.includes('POST'), `[${label}] fetch 记录含 url(带 sign)+ method`);
    }

    cleanup(dumpsDir, timelinesDir);
}

console.log('\n========== 验证结果 ==========');
// basic:大值短(全内联),验证七类 hook 抓到 + 明文/密文正确 + 栈非空 + 独立于总闸
await runCase('basic', true, 4, 2048);
// sidecar:明文超 maxInline=8,验证大 payload 旁落独立文件、内容完整不截断
await runCase('sidecar', true, 200, 8);
// disabled:jsHooks.enabled:false,验证注入但不落盘
await runCase('disabled', false, 4, 2048);
// capped:maxEntries=3,验证达上限熔断(防高频刷爆)
await runCase('capped', true, 4, 2048, 3);

server.close();

if (failed > 0) {
    console.log(`\n❌ JS Hook 探针未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log(
    '\n✅ JS Hook 探针端到端通过:主世界注入抓到 fetch/XHR/JSON.stringify/btoa/subtle.digest/CryptoJS/自定义签名函数' +
        '的明文↔密文+调用栈,短值内联、大 payload 旁落(完整不截断),独立于总闸,停用不落盘,maxEntries 达上限熔断。'
);
process.exit(0);
