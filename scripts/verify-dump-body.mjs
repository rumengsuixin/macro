// 回放端「请求体落盘」支路端到端自检:验证命中请求的**完整二进制请求体**被逐字节保真写成文件。
// 核心:页面发 **Blob** body(模拟 File/文件上传,如 YouTube 视频字节)——旧的 Playwright postDataBuffer
// 对 Blob 一律返回 null(抓不到),新的 CDP Fetch(postDataEntries base64 重组)能拿到完整字节。
// 另发一个 Uint8Array 用例,证 CDP 对普通 ArrayBuffer body 也 OK。
// 二进制体 = 全部 256 种字节值各出现 3 次(768 字节,含 0x00/0xFF 及大量无效 UTF-8),最能暴露编码损坏。
// session enabled:true + dumps:[{urlPattern:'*/upload*', extension:'mp4'}];MacroRunner 第 7 参传临时 dumpsDir。
// 用法:MACRO_HEADLESS=1 node scripts/verify-dump-body.mjs
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

// 全部 256 种字节值各出现 3 次(768 字节):覆盖 0x00/0xFF 及所有无效 UTF-8 字节,
// 若走 string 编解码路径必被 U+FFFD 替换损坏,唯有原始字节(CDP postDataEntries base64)能逐字节还原。
const bytes = Array.from({ length: 768 }, (_, i) => i % 256);
const expected = Buffer.from(bytes);

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        // kind=blob(默认,模拟 File 上传)| bytes(Uint8Array)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>dump-body</title>
<div id="host">初始化…</div>
<script>
(async function(){
  var kind = new URL(location.href).searchParams.get('kind') || 'blob';
  var arr = new Uint8Array(${JSON.stringify(bytes)});
  var body = kind === 'blob' ? new Blob([arr], {type:'video/mp4'}) : arr;
  try {
    await fetch('/upload', { method:'POST', headers:{'Content-Type':'video/mp4'}, body: body });
    var d = document.createElement('div'); d.id='done'; d.textContent='上传已完成'; document.body.appendChild(d);
  } catch (e) {
    var f = document.createElement('div'); f.id='failed'; f.textContent=String(e); document.body.appendChild(f);
  }
})();
</script>`);
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/upload')) {
        req.on('data', () => {});
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`本地 echo 服务已启动:http://127.0.0.1:${port}/`);

const sessionOptions = {
    requestRules: {
        enabled: true,
        rules: [],
        dumps: [{ urlPattern: '*/upload*', extension: 'mp4' }],
    },
};

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed += 1;
    }
}

// 跑一种 body 类型:回放 [goto ?kind=X, waitForSelector #done],断言临时 dumpsDir 落盘 1 个 mp4、逐字节相等
async function runCase(kind) {
    const dumpsDir = fs.mkdtempSync(path.join(os.tmpdir(), `macro-dump-${kind}-`));
    fs.mkdirSync(path.join(root, 'errors'), { recursive: true });
    const runner = new MacroRunner(
        path.join(root, 'errors'),
        undefined,
        undefined,
        sessionOptions,
        undefined,
        undefined,
        dumpsDir // 第 7 参:请求体落盘目录
    );
    const macro = {
        name: `dump-body-${kind}`,
        version: 1,
        steps: [
            { type: 'goto', url: `http://127.0.0.1:${port}/?kind=${kind}` },
            { type: 'waitForSelector', selector: '#done', timeout: 15000 },
        ],
    };
    let result;
    try {
        result = await Promise.race([
            runner.run(macro),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('自检硬超时(30s)')), 30000)
            ),
        ]);
    } catch (err) {
        console.error(`\n[${kind}] ❌ 回放异常:`, err.message);
        failed += 1;
        return;
    }
    // CDP Fetch.requestPaused → writeFileSync 在 continueRequest 前同步落盘,run 返回时应已就绪;给点余量
    await new Promise((r) => setTimeout(r, 200));
    const files = fs
        .readdirSync(dumpsDir)
        .filter((f) => f.startsWith('dump-') && f.endsWith('.mp4'));
    console.log(`\n[${kind}] result.ok=${result && result.ok},落盘文件:`, files);
    assert(result && result.ok === true, `[${kind}] 回放成功`);
    assert(files.length === 1, `[${kind}] 恰好落盘 1 个 mp4(实际 ${files.length})`);
    if (files.length >= 1) {
        const dumped = fs.readFileSync(path.join(dumpsDir, files[0]));
        assert(dumped.length === expected.length, `[${kind}] 字节数一致(${dumped.length})`);
        assert(
            Buffer.compare(dumped, expected) === 0,
            `[${kind}] 落盘内容与原始请求体**逐字节相等**(二进制保真)`
        );
    }
    try {
        fs.rmSync(dumpsDir, { recursive: true, force: true });
    } catch {
        /* 忽略 */
    }
}

console.log('\n========== 验证结果 ==========');
// blob:核心用例(旧 postDataBuffer 实现下会 0 落盘/失败,CDP 实现下通过);bytes:证 CDP 对普通 body 也 OK
await runCase('blob');
await runCase('bytes');

// 反证:string(UTF-8 编解码)路径会损坏这些字节——证明落盘必须走原始字节(postDataEntries base64)
const naiveRoundTrip = Buffer.from(expected.toString('utf-8'), 'utf-8');
assert(
    Buffer.compare(naiveRoundTrip, expected) !== 0,
    'string(UTF-8)路径会损坏这些字节(故落盘必须走原始字节)'
);

server.close();

if (failed > 0) {
    console.log(`\n❌ 回放端请求体落盘未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log(
    '\n✅ 回放端请求体落盘端到端通过:CDP Fetch 抓到 Blob(File)与 Uint8Array 上传体,逐字节保真写成 mp4。'
);
process.exit(0);
