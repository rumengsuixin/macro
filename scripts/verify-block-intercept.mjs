// 回放端「真拦截(硬阻断)」端到端自检:验证 Playwright route.abort() 真能把命中的请求拦下、不发出。
// 起一个本地 http echo 服务(同源提供测试页,免 CORS):
//   GET /        → 返回一张页面,自动并发 fetch('/allowed') 与 fetch('/blocked'),
//                  两者都 settle 后插入 #done(文本为各自结果的 JSON),让回放 waitForSelector 等到位。
//   GET /allowed → 记录命中并回 200(应正常到达)。
//   GET /blocked → 记录命中并回 200(应被 route.abort 拦下、服务端永不收到)。
// 挂真实 MacroRunner + requestRules:enabled:true, blocks:[{urlPattern:'*/blocked*'}]。
// 断言:① result.ok;② 服务端收到 /allowed;③ 服务端**从未**收到 /blocked(被硬阻断);
//       ④ 页面侧对 /blocked 捕获到网络错误(fetch reject)——即真跑通 route.abort() 分支。
// 用法:MACRO_HEADLESS=1 node scripts/verify-block-intercept.mjs
//   本机缺 headless_shell 时前置 PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// 服务端命中记录:记下真正到达服务器的路径
const hits = new Set();

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>block-intercept</title>
<div id="host">初始化…</div>
<script>
  var results = {};
  Promise.allSettled([
    fetch('/allowed').then(function () { results.allowed = 'ok'; },
                           function (e) { results.allowed = 'err:' + String(e); }),
    fetch('/blocked').then(function () { results.blocked = 'ok'; },
                           function (e) { results.blocked = 'err:' + String(e); })
  ]).then(function () {
    var d = document.createElement('div');
    d.id = 'done';
    d.textContent = JSON.stringify(results);
    document.body.appendChild(d);
  });
</script>`);
        return;
    }
    if (req.method === 'GET' && (req.url === '/allowed' || req.url.startsWith('/allowed?'))) {
        hits.add('/allowed');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('allowed-ok');
        return;
    }
    if (req.method === 'GET' && (req.url === '/blocked' || req.url.startsWith('/blocked?'))) {
        // 若被正确硬阻断,这段代码永不会执行到
        hits.add('/blocked');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('blocked-should-not-arrive');
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;
console.log(`本地 echo 服务已启动:${pageUrl}`);

const sessionOptions = {
    requestRules: {
        enabled: true,
        rules: [],
        blocks: [{ urlPattern: '*/blocked*' }],
    },
};

const macro = {
    name: 'block-intercept-test',
    version: 1,
    steps: [
        { type: 'goto', url: pageUrl },
        // 等两个 fetch 都 settle(#done 由 allSettled 回调插入),确保阻断/放行都已发生
        { type: 'waitForSelector', selector: '#done', timeout: 15000 },
    ],
};

fs.mkdirSync(path.join(root, 'errors'), { recursive: true });
const runner = new MacroRunner(path.join(root, 'errors'), undefined, undefined, sessionOptions);

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

// 判定依据:服务端命中记录 + 回放是否成功。
// 「/blocked 未到达服务端」是硬阻断的直接铁证(请求被 route.abort() 拦在浏览器侧、根本没发出);
// 「#done 已出现」(waitForSelector 通过 → result.ok)证明被阻断的 fetch 也已 settle(reject),回放未被卡死。

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('服务端命中 /allowed =', hits.has('/allowed'));
console.log('服务端命中 /blocked =', hits.has('/blocked'), '(期望 false)');

const pass =
    result &&
    result.ok === true &&
    hits.has('/allowed') === true && // 放行的请求正常到达
    hits.has('/blocked') === false; // 命中 block 的请求被硬阻断、服务端永不收到

if (pass) {
    console.log(
        '✅ 回放端真拦截生效:/blocked 被 route.abort() 硬阻断、服务端从未收到;/allowed 正常放行到达。'
    );
    process.exit(0);
} else {
    console.log('❌ 真拦截未达预期(期望 /allowed 到达且 /blocked 未到达)。');
    process.exit(1);
}
