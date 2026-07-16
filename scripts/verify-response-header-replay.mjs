// 回放端「响应头条件改写」端到端自检:验证 Playwright route.fetch()+route.fulfill()
// 真能在回放时按响应头条件改写响应头。起一个本地 http 服务(同源提供测试页,免 CORS):
//   GET /         → 返回一张自动 fetch('/api/data') 的页面。fetch 完成后读**改写后的**响应头:
//                   cc==='1' 且不含 x-drop → 插入 #done(证明改写生效);否则插入 #fail(带诊断)。
//   GET /api/data → 返回响应头 { xx:1, cc:0, x-drop:yes },并对每次命中计数(证明请求经 fetch 代发到达)。
// 挂真实 MacroRunner + responseRules(when xx=1 → setHeaders cc=1 + removeHeaders x-drop),
// 断言 result.ok===true(#done 出现) 且服务端 /api/data 被命中——即真跑通
//   context.route → route.fetch() → route.fulfill({response, headers}) 全链路。
// 用法(本机缺 headless_shell):PLAYWRIGHT_BROWSERS_PATH=build/ms-playwright MACRO_HEADLESS=1 \
//        node scripts/verify-response-header-replay.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let dataHit = 0;

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>response-header-replay</title>
<div id="host">初始化…</div>
<script>
  fetch('/api/data').then(function (r) {
    var cc = r.headers.get('cc');
    var drop = r.headers.get('x-drop');
    var ok = (cc === '1') && (drop === null);
    var d = document.createElement('div');
    d.id = ok ? 'done' : 'fail';
    d.textContent = 'cc=' + cc + ' x-drop=' + drop;
    document.body.appendChild(d);
  }).catch(function (e) {
    var d = document.createElement('div');
    d.id = 'fail';
    d.textContent = 'err:' + String(e);
    document.body.appendChild(d);
  });
</script>`);
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/data')) {
        dataHit += 1;
        // 原始响应头:xx=1(触发条件)、cc=0(将被覆盖成 1)、x-drop=yes(将被删除)
        res.writeHead(200, {
            'Content-Type': 'application/json',
            xx: '1',
            cc: '0',
            'x-drop': 'yes',
        });
        res.end('{"data":1}');
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
                urlPattern: '*/api/data*',
                when: { xx: '1' },
                setHeaders: { cc: '1' },
                removeHeaders: ['x-drop'],
            },
        ],
    },
};

const macro = {
    name: 'response-header-replay-test',
    version: 1,
    steps: [
        { type: 'goto', url: pageUrl },
        // 等 fetch 完成:#done 仅在「改写后的响应头 cc=1 且无 x-drop」时才被插入
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
console.log('/api/data 命中次数 =', dataHit);

const pass = result && result.ok === true && dataHit >= 1;

if (pass) {
    console.log(
        '✅ 回放端 route.fetch()+fulfill() 成功改写响应头:满足 xx=1 → cc 覆盖为 1、删除 x-drop(页面 #done 出现)。'
    );
    process.exit(0);
} else {
    console.log(
        '❌ 回放端响应头改写未达预期(期望 #done 出现即 cc=1 且无 x-drop,且 /api/data 被命中)。'
    );
    process.exit(1);
}
