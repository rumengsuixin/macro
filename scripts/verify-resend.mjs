// 回放端「重发型」拦截端到端自检:验证命中触发请求后,延时 n 秒改参、主动重发一个新请求。
//
// 设计(仿 verify-hotreload 骨架,但页面只发一次触发请求):
//  - 本地 echo 服务:GET / 返回测试页,加载即发**1 个** POST /trigger(body {page:1});
//    页面不轮询,后续的 /trigger 只可能来自 runner 的主动重发。
//  - POST /trigger 记录 { body, resent:!!headers['x-macro-resend'], ts }(到达顺序)。
//  - session:enabled:true、rules:[](改写全关,证明重发独立于改写)、
//    resends:[{ urlPattern:'*/trigger*', delayMs:1500, bodyType:'json', set:{resent_flag:'yes'} }]。
//  - 宏 = [goto, pause];onPause 轮询「≥1 原始 && ≥1 重发」才 resolve(让宏正常收尾 run.ok=true)。
// 断言:①恰 1 条原始(无标记头/无 resent_flag);②≥1 条重发(有标记头 && resent_flag=yes && page 仍=1
//       证基于原 body 改参);③时序 resend.ts-original.ts >= delayMs-300;④等足够久后重发数==repeat(=1)
//       不增长(证标记头阻断了自触发递归)。
// 延时是 runner 内 Node setTimeout(不受无头页面定时器节流影响)。
// 用法:MACRO_HEADLESS=1 node scripts/verify-resend.mjs
//   缺 headless_shell 时:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright MACRO_HEADLESS=1 node ...
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const DELAY_MS = 1500; // 重发延时(与 session 配置一致)

/** 服务端收到的每个 /trigger:{ body(已解析), resent(是否带标记头), ts } */
const received = [];

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // 页面加载即发**一次** POST /trigger,不轮询;后续 /trigger 只可能是 runner 的重发
        res.end(`<!doctype html><meta charset="utf-8"><title>resend</title>
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
        let data = '';
        req.on('data', (c) => {
            data += c;
        });
        req.on('end', () => {
            let body;
            try {
                body = JSON.parse(data);
            } catch {
                body = { _raw: data };
            }
            received.push({
                body,
                resent: !!req.headers['x-macro-resend'],
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
console.log(`本地 echo 服务已启动:${pageUrl}`);

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
        rules: [], // 改写全关:证明重发独立于改写
        resends: [
            {
                urlPattern: '*/trigger*',
                delayMs: DELAY_MS,
                bodyType: 'json',
                set: { resent_flag: 'yes' },
                repeat: 1,
            },
        ],
    },
};
const runner = new MacroRunner(path.join(root, 'errors'), undefined, onPause, session);

const macro = {
    name: 'resend-test',
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
    process.exit(1);
}

// 再等 2s,验证重发不会自触发递归(重发数应保持 == repeat)
await new Promise((r) => setTimeout(r, 2000));
server.close();

const original = received.filter((r) => !r.resent);
const resent = received.filter((r) => r.resent);

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('总请求 =', received.length, '| 原始 =', original.length, '| 重发 =', resent.length);
if (original[0]) console.log('原始 body =', JSON.stringify(original[0].body));
if (resent[0]) console.log('重发 body =', JSON.stringify(resent[0].body));
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
    original[0] && original[0].body.resent_flag === undefined,
    '原始请求未被改参(无 resent_flag)'
);
assert(resent.length >= 1, `至少 1 条重发请求(实际 ${resent.length})`);
assert(
    resent[0] && resent[0].body.resent_flag === 'yes',
    '重发请求已改参(resent_flag=yes)'
);
assert(
    resent[0] && resent[0].body.page === 1,
    '重发基于原 body(page 仍为 1)'
);
assert(
    original[0] && resent[0] && resent[0].ts - original[0].ts >= DELAY_MS - 300,
    `重发延时 ≥ ${DELAY_MS - 300}ms(证"n 秒后重发")`
);
assert(resent.length === 1, `重发数 == repeat(=1)不增长(证防递归,实际 ${resent.length})`);

if (failed > 0) {
    console.log(`\n❌ 重发功能未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log('\n✅ 回放端「重发型」拦截通过:命中后延时改参重发,基于原 body、防递归、独立于改写。');
process.exit(0);
