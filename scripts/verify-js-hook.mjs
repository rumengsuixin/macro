// 回放端「JS Hook 探针(jsHooks)」端到端自检。
// 验证:向页面主世界注入 hook 脚本 + exposeBinding 回传管子后,能抓到
//   ① 网络出口 fetch(发出前的 url/method/body)
//   ② JSON.stringify(明文对象 → 字符串)
//   ③ btoa(base64 编码前后)
//   ④ **平台自定义签名函数**(hookPaths 指定的 window.mySign)的「明文入参 ↔ 密文出参 + 调用栈」
// 并验证:短值内联进索引 / 超 maxInline 的大 payload 旁落独立文件(完整不截断);
//        jsHooks 独立于改写总闸(enabled:false 仍抓);jsHooks.enabled:false 时注入但不落盘。
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
        // 页面脚本:先定义自定义签名函数 mySign(注入脚本已在 document-start 装 setter,赋值即被惰性包裹),
        // 再走 JSON.stringify → mySign(内部调 btoa)→ fetch 带 sign。全程触发 4 类 hook。
        res.end(`<!doctype html><meta charset="utf-8"><title>js-hook</title><div id="host">初始化…</div>
<script>
(function(){
  try {
    window.mySign = function(x){ return btoa(x); };
    var plain = JSON.stringify({a:1, b:'hello', big:'B'.repeat(${bigLen})});
    var sig = window.mySign(plain);
    fetch('/api/echo?sign=' + encodeURIComponent(sig), { method:'POST', body: plain })
      .then(function(r){ return r.text(); })
      .then(function(){ var d=document.createElement('div'); d.id='done'; d.textContent='往返完成'; document.body.appendChild(d); })
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

// 跑一种配置:jsEnabled=jsHooks.enabled;bigLen=页面 big 长度;maxInline=内联阈值。
async function runCase(label, jsEnabled, bigLen, maxInline) {
    const dumpsDir = fs.mkdtempSync(path.join(os.tmpdir(), `macro-jshook-${label}-`));
    const timelinesDir = fs.mkdtempSync(path.join(os.tmpdir(), `macro-jshook-tl-${label}-`));
    fs.mkdirSync(path.join(root, 'errors'), { recursive: true });
    const sessionOptions = {
        requestRules: {
            enabled: false, // 改写总闸关:证 jsHooks 随自身 enabled 走、独立于总闸
            rules: [],
            jsHooks: {
                enabled: jsEnabled,
                rules: [
                    {
                        urlPattern: '*',
                        apis: ['fetch', 'json', 'btoa'],
                        hookPaths: ['mySign'],
                        maxInline,
                    },
                ],
            },
        },
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
    await new Promise((r) => setTimeout(r, 300)); // 给 exposeBinding 回调落盘留余量

    const { idxFiles, entries } = loadIndex(dumpsDir);
    const apis = entries.map((e) => e.api);
    console.log(`\n[${label}] result.ok=${result && result.ok},索引条数=${entries.length},apis=`, apis);
    assert(result && result.ok === true, `[${label}] 回放成功`);

    const expectedPlain = plaintextFor(bigLen);
    const expectedSig = b64(expectedPlain);

    if (!jsEnabled) {
        // 停用:注入脚本仍在页面(抓 + 回传),但 Node 侧丢弃 → 不生成索引文件
        assert(idxFiles.length === 0, `[${label}] jsHooks.enabled:false 时不生成索引(注入但不落盘)`);
        cleanup(dumpsDir, timelinesDir);
        return;
    }

    assert(idxFiles.length === 1, `[${label}] 恰好生成 1 个索引文件(实际 ${idxFiles.length})`);
    assert(apis.includes('custom:mySign'), `[${label}] 抓到自定义签名函数 custom:mySign`);
    assert(apis.includes('json'), `[${label}] 抓到 JSON.stringify`);
    assert(apis.includes('btoa'), `[${label}] 抓到 btoa`);
    assert(apis.includes('fetch'), `[${label}] 抓到 fetch`);

    const sign = entries.find((e) => e.api === 'custom:mySign');
    if (sign) {
        assert(typeof sign.stack === 'string' && sign.stack.length > 0, `[${label}] custom:mySign 带非空调用栈(可定位函数)`);
        const gotIn = readField(dumpsDir, sign, 'in');
        const gotOut = readField(dumpsDir, sign, 'out');
        assert(gotIn === expectedPlain, `[${label}] mySign 明文入参正确(${plaintextFor(bigLen).length} 字节)`);
        assert(gotOut === expectedSig, `[${label}] mySign 密文出参正确(= btoa(明文))`);
        // 内联 / 旁落 二选一,取决于 maxInline
        const inlined = sign.input !== undefined;
        if (Buffer.byteLength(expectedPlain, 'utf-8') > maxInline) {
            assert(!inlined && !!sign.inputFile, `[${label}] 明文超 maxInline(${maxInline})→ 旁落文件(${sign.inputFile})`);
        } else {
            assert(inlined && !sign.inputFile, `[${label}] 明文未超 maxInline → 内联进索引`);
        }
    }

    const fx = entries.find((e) => e.api === 'fetch');
    if (fx) {
        const inp = readField(dumpsDir, fx, 'in') || ''; // maxInline 小时 fetch input 也会旁落文件
        assert(inp.includes('/api/echo') && inp.includes('sign=') && inp.includes('POST'), `[${label}] fetch 记录含 url(带 sign)+ method`);
    }

    cleanup(dumpsDir, timelinesDir);
}

// 读一个 hook 字段(内联则直接取;旁落则从文件读),统一返回字符串(base64 字段解码回原文对比)
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
        const buf = fs.readFileSync(path.join(dumpsDir, entry[fileKey]));
        return buf.toString('utf-8'); // 本测明文/密文均为文本
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

console.log('\n========== 验证结果 ==========');
// basic:大值短(全内联),验证四类 hook 抓到 + 明文/密文正确 + 栈非空 + 独立于总闸
await runCase('basic', true, 4, 2048);
// sidecar:明文超 maxInline=8,验证大 payload 旁落独立文件、内容完整不截断
await runCase('sidecar', true, 200, 8);
// disabled:jsHooks.enabled:false,验证注入但不落盘(无索引文件)
await runCase('disabled', false, 4, 2048);

server.close();

if (failed > 0) {
    console.log(`\n❌ JS Hook 探针未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log(
    '\n✅ JS Hook 探针端到端通过:主世界注入抓到 fetch/JSON.stringify/btoa/自定义签名函数的明文↔密文+调用栈,' +
        '短值内联、大 payload 旁落独立文件(完整不截断),独立于改写总闸,停用时注入但不落盘。'
);
process.exit(0);
