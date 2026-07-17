// 回放端「重发型 + 本地文件整体替换 body」端到端自检:
// 验证一条 resends 规则配了 replaceWithFile 时,命中触发请求后,主动重发的**新请求**的 body
// == 该本地文件的完整字节(逐字节相等,含无效 UTF-8),而不是取原 body 改参。
//
// 设计(仿 verify-resend 的触发骨架 + verify-body-replace 的二进制逐字节断言):
//  - 本地 echo 服务:GET / 返回测试页,加载即发**1 个** POST /trigger(body JSON {page:1});
//    页面不轮询,后续的 /trigger 只可能来自 runner 的主动重发。
//  - POST /trigger 记录 { raw:Buffer(原始字节,不 JSON.parse), resent:!!headers['x-macro-resend'], ct, ts }。
//  - 替换文件 B = 600 字节全字节值(含无效 UTF-8),落临时文件。
//  - session:enabled:true、rules:[](改写全关)、
//    resends:[{ urlPattern:'*/trigger*', delayMs:800, replaceWithFile:B }](无 set/append/remove)。
//  - 宏 = [goto, pause];onPause 轮询「≥1 原始 && ≥1 重发」才 resolve(让宏正常收尾 run.ok=true)。
// 断言:①恰 1 条原始(无标记头)且其字节 != B(原触发未被动);②≥1 条重发(有标记头);
//       ③重发字节 == B **逐字节相等**(文件整体替换生效,能发任意二进制);④时序 ≥ delayMs-300。
// 用法:MACRO_HEADLESS=1 node scripts/verify-resend-replace.mjs
//   缺 headless_shell 时:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright MACRO_HEADLESS=1 node ...
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const DELAY_MS = 800; // 重发延时(与 session 配置一致)

// 替换文件 B = 600 字节全字节值(含无效 UTF-8),落临时文件
const bytesB = Array.from({ length: 600 }, (_, i) => (i * 7 + 3) % 256);
const bufB = Buffer.from(bytesB);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-resend-replace-'));
const replaceFile = path.join(tmpDir, 'replacement.bin');
fs.writeFileSync(replaceFile, bufB);

/** 服务端收到的每个 /trigger:{ raw(原始字节 Buffer), resent(是否带标记头), ct, ts } */
const received = [];

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // 页面加载即发**一次** POST /trigger(JSON {page:1}),不轮询;后续 /trigger 只可能是 runner 的重发
        res.end(`<!doctype html><meta charset="utf-8"><title>resend-replace</title>
<div id="host">running</div>
<script>
  fetch('/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 1 })
  }).catch(function () {});
</script>`);
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/trigger')) {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            received.push({
                raw: Buffer.concat(chunks),
                resent: !!req.headers['x-macro-resend'],
                ct: req.headers['content-type'],
                ts: Date.now(),
            });
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
console.log(`本地 echo 服务已启动:${pageUrl}  替换文件 B=${bufB.length} 字节`);

// onPause:保持回放存活,直到收到「≥1 原始 + ≥1 重发」才 resolve(让 pause 结束、宏正常收尾)
const onPause = () =>
    new Promise((resolve) => {
        const iv = setInterval(() => {
            const original = received.filter((r) => !r.resent);
            const resent = received.filter((r) => r.resent);
            if (original.length >= 1 && resent.length >= 1) {
                clearInterval(iv);
                resolve();
            }
        }, 100);
    });

fs.mkdirSync(path.join(root, 'errors'), { recursive: true });
const session = {
    requestRules: {
        enabled: true,
        rules: [], // 改写全关
        resends: [
            {
                urlPattern: '*/trigger*',
                delayMs: DELAY_MS,
                replaceWithFile: replaceFile, // 整体用文件字节作重发体(无 set/append/remove)
            },
        ],
    },
};
const runner = new MacroRunner(path.join(root, 'errors'), undefined, onPause, session);

const macro = {
    name: 'resend-replace-test',
    version: 1,
    steps: [
        { type: 'goto', url: pageUrl },
        { type: 'pause' }, // onPause 轮询到「原始 + 重发」各 1 后放行,宏收尾
    ],
};

let result;
try {
    result = await Promise.race([
        runner.run(macro),
        new Promise((_, reject) => setTimeout(() => reject(new Error('自检硬超时(30s)')), 30000)),
    ]);
} catch (err) {
    console.log('❌ 回放异常:', err.message);
    server.close();
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        /* 忽略 */
    }
    process.exit(1);
}

// 再等 1s,确保后到的重发(若有)也被计入
await new Promise((r) => setTimeout(r, 1000));
server.close();
try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
    /* 忽略 */
}

const original = received.filter((r) => !r.resent);
const resent = received.filter((r) => r.resent);

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('总请求 =', received.length, '| 原始 =', original.length, '| 重发 =', resent.length);
if (original[0]) console.log('原始 body 字节数 =', original[0].raw.length);
if (resent[0]) console.log('重发 body 字节数 =', resent[0].raw.length, `(替换文件 B=${bufB.length})`);
if (original[0] && resent[0]) {
    console.log('重发延时(ms) ≈', resent[0].ts - original[0].ts, `(配置 ${DELAY_MS})`);
}

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
assert(original.length === 1, `恰有 1 条原始请求(实际 ${original.length})`);
assert(
    original[0] && Buffer.compare(original[0].raw, bufB) !== 0,
    '原始请求体 != 替换文件 B(原触发未被动到)'
);
assert(resent.length >= 1, `至少 1 条重发请求(实际 ${resent.length})`);
assert(
    resent[0] && Buffer.compare(resent[0].raw, bufB) === 0,
    `重发体 == 替换文件 B **逐字节相等**(${resent[0] ? resent[0].raw.length : '?'}=${bufB.length},文件整体替换生效、能发任意二进制)`
);
assert(
    original[0] && resent[0] && resent[0].ts - original[0].ts >= DELAY_MS - 300,
    `重发延时 ≥ ${DELAY_MS - 300}ms(证"延时后重发")`
);

if (failed > 0) {
    console.log(`\n❌ resends 文件整体替换未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log(
    '\n✅ 回放端「重发 + 本地文件整体替换 body」通过:命中触发后延时重发,重发体 == 本地文件字节(逐字节相等)。'
);
process.exit(0);
