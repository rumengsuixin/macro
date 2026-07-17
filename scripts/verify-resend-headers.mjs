// 回放端「重发型」拦截:改重发请求头(setHeaders 覆盖 / removeHeaders 删除)端到端自检。
//
// 设计(仿 verify-resend 骨架,页面只发一次触发请求):
//  - 本地 echo 服务:GET / 返回测试页,加载即发 **1 个** POST /trigger;
//    触发请求特意带两个自定义头:x-inherited(将被 removeHeaders 删)、x-keep(应被继承保留)。
//  - POST /trigger 记录 { body, resent:!!headers['x-macro-resend'], headers, ts }(整份 headers)。
//  - session:enabled:true、rules:[](改写全关),
//    resends:[{ urlPattern:'*/trigger*', delayMs, setHeaders:{'x-custom':'injected'},
//               removeHeaders:['x-inherited'] }]。
//  - 宏 = [goto, pause];onPause 轮询「≥1 原始 && ≥1 重发」才 resolve。
// 断言:①setHeaders 生效(重发头含 x-custom=injected);②继承生效(重发头含 x-keep,证 removeHeaders
//       测试非空跑);③removeHeaders 生效(重发头**不含** x-inherited——本会被继承却被删);
//       ④防递归标记头受保护(重发头含 x-macro-resend=1,即便用户没碰它);⑤原始请求不受影响
//       (仍含 x-inherited、不含 x-custom);⑥时序 ≥ delayMs-300;⑦重发数==repeat(=1)不增长(防递归)。
// 用法:MACRO_HEADLESS=1 node scripts/verify-resend-headers.mjs
//   缺 headless_shell 时:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright MACRO_HEADLESS=1 node ...
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const DELAY_MS = 1200; // 重发延时(与 session 配置一致)

/** 服务端收到的每个 /trigger:{ body, resent(是否带标记头), headers(整份), ts } */
const received = [];

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // 页面加载即发**一次** POST /trigger,带两个自定义请求头供验证;后续 /trigger 只可能是 runner 的重发
        res.end(`<!doctype html><meta charset="utf-8"><title>resend-headers</title>
<div id="host">running</div>
<script>
  fetch('/trigger', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-inherited': 'drop-me',
      'x-keep': 'inherited-ok'
    },
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
                headers: req.headers, // 整份保存,供断言请求头改写
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
        rules: [], // 改写全关:证明重发/改头独立于改写
        resends: [
            {
                urlPattern: '*/trigger*',
                delayMs: DELAY_MS,
                bodyType: 'json',
                setHeaders: { 'x-custom': 'injected' }, // 覆盖/新增请求头
                removeHeaders: ['x-inherited'], // 删掉继承来的头
                repeat: 1,
            },
        ],
    },
};
const runner = new MacroRunner(path.join(root, 'errors'), undefined, onPause, session);

const macro = {
    name: 'resend-headers-test',
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

// 再等一会儿,验证重发不会自触发递归(重发数应保持 == repeat)
await new Promise((r) => setTimeout(r, 1500));
server.close();

const original = received.filter((r) => !r.resent);
const resent = received.filter((r) => r.resent);

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('总请求 =', received.length, '| 原始 =', original.length, '| 重发 =', resent.length);
if (original[0]) {
    console.log(
        '原始 headers:x-inherited =', original[0].headers['x-inherited'],
        '| x-keep =', original[0].headers['x-keep'],
        '| x-custom =', original[0].headers['x-custom']
    );
}
if (resent[0]) {
    console.log(
        '重发 headers:x-custom =', resent[0].headers['x-custom'],
        '| x-keep =', resent[0].headers['x-keep'],
        '| x-inherited =', resent[0].headers['x-inherited'],
        '| x-macro-resend =', resent[0].headers['x-macro-resend']
    );
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
assert(resent.length >= 1, `至少 1 条重发请求(实际 ${resent.length})`);
assert(
    resent[0] && resent[0].headers['x-custom'] === 'injected',
    'setHeaders 生效:重发头含 x-custom=injected'
);
assert(
    resent[0] && resent[0].headers['x-keep'] === 'inherited-ok',
    '请求头继承生效:重发头含 x-keep(证 removeHeaders 断言非空跑)'
);
assert(
    resent[0] && resent[0].headers['x-inherited'] === undefined,
    'removeHeaders 生效:重发头不含 x-inherited(本会被继承却被删)'
);
assert(
    resent[0] && resent[0].headers['x-macro-resend'] === '1',
    '防递归标记头受保护:重发头含 x-macro-resend=1'
);
assert(
    original[0] && original[0].headers['x-inherited'] === 'drop-me',
    '原始请求未受影响:仍含 x-inherited=drop-me'
);
assert(
    original[0] && original[0].headers['x-custom'] === undefined,
    '原始请求未受影响:不含 x-custom'
);
assert(
    original[0] && resent[0] && resent[0].ts - original[0].ts >= DELAY_MS - 300,
    `重发延时 ≥ ${DELAY_MS - 300}ms(证"n 秒后重发")`
);
assert(
    resent.length === 1,
    `重发数 == repeat(=1)不增长(证防递归,实际 ${resent.length})`
);

if (failed > 0) {
    console.log(`\n❌ 重发请求头改写未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log(
    '\n✅ 回放端「重发型」请求头改写通过:setHeaders 覆盖/新增、removeHeaders 删除、标记头受保护、原始请求不受影响。'
);
process.exit(0);
