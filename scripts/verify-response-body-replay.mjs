// 回放端「响应体/状态码/mock 改写」(P0-1)端到端自检:验证 Playwright route.fetch()+route.fulfill()
// 真能在回放时改写响应体、覆盖状态码,以及 mock(不打后端直接返回假响应)。
// 起本地 http 服务(同源提供测试页,免 CORS):
//   GET /         → 页面依次 fetch('/api/real') 与 fetch('/api/mock'),读**改写后的**状态码/正文并判定。
//   GET /api/real → 原始返回 200 {"v":"original"}(将被规则改成 403 + {"v":"rewritten"}),命中计数 realHit。
//   GET /api/mock → 原始会 404(将被 mock 拦下,后端**不应被命中**),命中计数 mockHit(期望 0)。
// 挂真实 MacroRunner + responseRules:
//   ① */api/real* : setBody + setStatus(改真实响应体与状态码)
//   ② */api/mock* : mock:true + setStatus + setBody + setHeaders(mock 假响应)
// 断言 result.ok===true(#done 出现) 且 realHit>=1、mockHit===0。
// 用法(本机缺 headless_shell):PLAYWRIGHT_BROWSERS_PATH=build/ms-playwright MACRO_HEADLESS=1 \
//        node scripts/verify-response-body-replay.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let realHit = 0;
let mockHit = 0;

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>response-body-replay</title>
<div id="host">初始化…</div>
<script>
  (async function () {
    try {
      var r1 = await fetch('/api/real');
      var t1 = await r1.text();
      var okReal = (r1.status === 403) && (t1 === '{"v":"rewritten"}');

      var r2 = await fetch('/api/mock');
      var t2 = await r2.text();
      var okMock = (r2.status === 200) && (t2 === '{"v":"mocked"}');

      var ok = okReal && okMock;
      var d = document.createElement('div');
      d.id = ok ? 'done' : 'fail';
      d.textContent = 'real[s=' + r1.status + ' b=' + t1 + '] mock[s=' + r2.status + ' b=' + t2 + ']';
      document.body.appendChild(d);
    } catch (e) {
      var f = document.createElement('div');
      f.id = 'fail';
      f.textContent = 'err:' + String(e);
      document.body.appendChild(f);
    }
  })();
</script>`);
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/real')) {
        realHit += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"v":"original"}');
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/mock')) {
        mockHit += 1; // 期望永远为 0:mock 规则应在回放端直接 fulfill,不打到后端
        res.writeHead(404);
        res.end('should-not-be-reached');
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;
console.log(`本地服务已启动:${pageUrl}`);

const sessionOptions = {
    requestRules: {
        enabled: true,
        rules: [],
        responseRules: [
            {
                // ① 改真实响应:整体替换响应体 + 覆盖状态码(无 when → 无条件生效)
                urlPattern: '*/api/real*',
                setBody: '{"v":"rewritten"}',
                setStatus: 403,
            },
            {
                // ② mock 假响应:不发真实请求,直接构造 200 + json 体
                urlPattern: '*/api/mock*',
                mock: true,
                setStatus: 200,
                setBody: '{"v":"mocked"}',
                setHeaders: { 'content-type': 'application/json' },
            },
        ],
    },
};

const macro = {
    name: 'response-body-replay-test',
    version: 1,
    steps: [
        { type: 'goto', url: pageUrl },
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

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('/api/real 命中次数 =', realHit, '(期望 >=1:经 route.fetch 代发到达)');
console.log('/api/mock 命中次数 =', mockHit, '(期望 0:mock 直接 fulfill、不打后端)');

const pass = result && result.ok === true && realHit >= 1 && mockHit === 0;

if (pass) {
    console.log(
        '✅ 回放端成功:①真实响应体被改为 {"v":"rewritten"} 且状态码 403;②mock 返回 {"v":"mocked"} 且后端未被命中(#done 出现)。'
    );
    process.exit(0);
} else {
    console.log(
        '❌ 未达预期(期望 #done 出现:real 状态=403+体=rewritten、mock 状态=200+体=mocked;realHit>=1、mockHit=0)。'
    );
    process.exit(1);
}
