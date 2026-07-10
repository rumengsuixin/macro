// 回放端请求改写端到端自检:验证 Playwright route 真能改写「回放时发出的 POST body」。
// 起一个本地 http echo 服务(同源提供测试页,免 CORS):
//   GET /     → 返回一张自动 fetch('POST /echo', json, {page:1,size:20,debug:true}) 的页面,
//               fetch 完成后插入 #done 元素(让回放 waitForSelector 等到 POST 真正打出并返回)。
//   POST /echo→ 记录收到的 body 并回 200。
// 挂真实 MacroRunner + requestRules 规则(set size=100/injected=yes、remove debug),
// 断言服务端实收 body = {page:1,size:100,injected:"yes"} 且无 debug——即真跑通
//   context.route → request.postData() → route.continue({postData}) 全链路。
// 用法:MACRO_HEADLESS=1 node scripts/verify-replay-intercept.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let receivedBody = null;

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>replay-intercept</title>
<div id="host">初始化…</div>
<script>
  fetch('/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 1, size: 20, debug: true })
  }).then(function () {
    var d = document.createElement('div');
    d.id = 'done';
    d.textContent = 'POST 已完成';
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
    if (req.method === 'POST' && req.url.startsWith('/echo')) {
        let data = '';
        req.on('data', (c) => {
            data += c;
        });
        req.on('end', () => {
            receivedBody = data;
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

// 与录制端 e2e 同一套断言目标:set size=100/injected=yes、remove debug
const sessionOptions = {
    requestRules: {
        enabled: true,
        rules: [
            {
                urlPattern: '*/echo*',
                bodyType: 'json',
                set: { size: 100, injected: 'yes' },
                remove: ['debug'],
            },
        ],
    },
};

const macro = {
    name: 'replay-intercept-test',
    version: 1,
    steps: [
        { type: 'goto', url: pageUrl },
        // 等 fetch 完成(#done 由 then 回调插入),确保 POST 真正打出并被 route 拦到
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
console.log('receivedBody =', receivedBody);

let parsed = null;
try {
    parsed = receivedBody ? JSON.parse(receivedBody) : null;
} catch {
    /* 解析失败按 null 处理 */
}

const pass =
    result &&
    result.ok === true &&
    parsed &&
    parsed.size === 100 &&
    parsed.injected === 'yes' &&
    parsed.page === 1 &&
    !('debug' in parsed);

if (pass) {
    console.log(
        '✅ 回放端 route 成功改写 POST body:size→100、注入 injected=yes、删除 debug、保留 page=1。'
    );
    process.exit(0);
} else {
    console.log('❌ 回放端请求改写未达预期(期望 {page:1,size:100,injected:"yes"} 且无 debug)。');
    process.exit(1);
}
