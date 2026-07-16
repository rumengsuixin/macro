// 回放端「请求体落盘(dump 成 mp4)」支路端到端自检:验证命中请求的**完整二进制请求体**被
// 逐字节保真地写成一个文件(证明用的是 postDataBuffer 原始字节,而非会损坏二进制的 postData string)。
// 起本地 http echo 服务(同源提供测试页,免 CORS):页面自动 fetch('POST /upload', <二进制体>) 后插 #done。
// 二进制体 = 全部 256 种字节值各出现 3 次(含 0x00/0xFF 及大量无效 UTF-8 字节),最能暴露编码损坏。
// session enabled:true + dumps:[{urlPattern:'*/upload*', extension:'mp4'}];MacroRunner 第 7 参传临时 dumpsDir。
// 跑 [goto, waitForSelector('#done')] 后读 dumps/dump-*.mp4,断言其字节与页面发出的原始 Buffer 逐字节相等。
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
// 若走 string(postData)编解码路径必被 U+FFFD 替换损坏,唯有 postDataBuffer 原始字节能逐字节还原。
const bytes = Array.from({ length: 768 }, (_, i) => i % 256);
const expected = Buffer.from(bytes);

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>dump-body</title>
<div id="host">初始化…</div>
<script>
  var bytes = ${JSON.stringify(bytes)};
  fetch('/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4' },
    body: new Uint8Array(bytes)
  }).then(function () {
    var d = document.createElement('div');
    d.id = 'done';
    d.textContent = '上传已完成';
    document.body.appendChild(d);
  }).catch(function (e) {
    var d = document.createElement('div');
    d.id = 'failed';
    d.textContent = String(e);
    document.body.appendChild(d);
  });
</script>`);
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/upload')) {
        // 服务端消费完 body 再响应,让页面 fetch 正常 resolve(内容本身由回放端 dump,不靠服务端)
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
const pageUrl = `http://127.0.0.1:${port}/`;
console.log(`本地 echo 服务已启动:${pageUrl}`);

// 临时落盘输出目录
const dumpsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-dump-'));

// enabled:true + dumps 一条:受总开关控制的落盘支路(rules 空,不触发改写、不注册 route)
const sessionOptions = {
    requestRules: {
        enabled: true,
        rules: [],
        dumps: [{ urlPattern: '*/upload*', extension: 'mp4' }],
    },
};

const macro = {
    name: 'dump-body-test',
    version: 1,
    steps: [
        { type: 'goto', url: pageUrl },
        { type: 'waitForSelector', selector: '#done', timeout: 15000 },
    ],
};

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

let result;
try {
    result = await Promise.race([
        runner.run(macro),
        new Promise((_, reject) => setTimeout(() => reject(new Error('自检硬超时(30s)')), 30000)),
    ]);
} catch (err) {
    console.log('❌ 回放异常:', err.message);
    server.close();
    process.exit(1);
}

server.close();

// dump 是在 context.on('request') 同步回调里 writeFileSync,run 返回时应已落盘;稳妥起见给一点余量
await new Promise((r) => setTimeout(r, 200));

// 读取临时目录里的 dump-*.mp4
const files = fs.readdirSync(dumpsDir).filter((f) => f.startsWith('dump-') && f.endsWith('.mp4'));

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('落盘文件:', files);

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed += 1;
    }
}

assert(result && result.ok === true, '回放成功(result.ok=true)');
assert(files.length === 1, `恰好落盘 1 个 mp4 文件(实际 ${files.length})`);

let dumped = null;
if (files.length >= 1) {
    dumped = fs.readFileSync(path.join(dumpsDir, files[0])); // 二进制读入
    assert(dumped.length === expected.length, `字节数一致(期望 ${expected.length},实际 ${dumped.length})`);
    assert(Buffer.compare(dumped, expected) === 0, '落盘内容与原始请求体**逐字节相等**(二进制保真)');
}

// 反证:若走 string(postData)路径,这些无效 UTF-8 字节会被 U+FFFD 替换损坏——证明必须用 postDataBuffer
const naiveRoundTrip = Buffer.from(expected.toString('utf-8'), 'utf-8');
assert(
    Buffer.compare(naiveRoundTrip, expected) !== 0,
    'string(postData)路径会损坏这些字节(故落盘必须用 postDataBuffer)'
);

// 清理临时目录
try {
    fs.rmSync(dumpsDir, { recursive: true, force: true });
} catch {
    /* 忽略 */
}

if (failed > 0) {
    console.log(`\n❌ 回放端请求体落盘未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log('\n✅ 回放端请求体落盘端到端通过:命中请求的完整二进制请求体被逐字节保真写成 mp4 文件。');
process.exit(0);
