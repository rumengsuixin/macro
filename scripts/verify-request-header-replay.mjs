// 回放端「请求头条件改写」端到端自检:验证 Playwright route.continue({headers}) / route.fetch({headers})
// 真能在回放时按 when 条件改写**原始请求**的请求头。起一个本地 http 服务(同源提供测试页,免 CORS):
//   GET /               → 返回页面,依次发三个请求;全部成功插 #done。
//   GET /api/probe-a    → 存收到的 req.headers 到 receivedA(组合 a:GET,set/remove/保留)。
//   GET /api/probe-b    → 存 receivedB(when 门槛:规则 when 不满足,不应改)。
//   POST /api/submit    → 收 body + headers 到 receivedSubmit(组合 b:body 改写 + 头改写一次 continue 合并;
//                         天然验证 content-length 剥离——body 被改长,旧 content-length 若不剥则读不到 injected)。
// 断言均在**服务端**(页面无法读自身出站头):setHeaders 注入 / removeHeaders 删除 / 未列头保留 /
//   when 不满足不改 / 组合 b 里 body 与请求头同时改写。
// 用法(本机缺 headless_shell):PLAYWRIGHT_BROWSERS_PATH=build/ms-playwright MACRO_HEADLESS=1 \
//        node scripts/verify-request-header-replay.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let probeAHit = 0;
let probeBHit = 0;
let submitHit = 0;
let receivedA = null;
let receivedB = null;
let receivedSubmit = null;

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>request-header-replay</title>
<div id="host">初始化…</div>
<script>
  (async function () {
    try {
      // 组合 a:GET,页面自带 x-orig(将被保留、作 when 依据)与 x-drop-me(将被删)
      var ra = await fetch('/api/probe-a', { headers: { 'x-orig': 'keep', 'x-drop-me': 'v' } });
      // when 门槛:规则 when 要求 x-orig=keep,这里发 other → 不应改
      var rb = await fetch('/api/probe-b', { headers: { 'x-orig': 'other' } });
      // 组合 b:POST,body 被 rules 改(变长)、请求头被 requestHeaderRules 改,合并一次 continue
      var rs = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orig': 'keep' },
        body: JSON.stringify({ page: 1 }),
      });
      var ok = ra.ok && rb.ok && rs.ok;
      var d = document.createElement('div');
      d.id = ok ? 'done' : 'fail';
      d.textContent = 'a=' + ra.status + ' b=' + rb.status + ' s=' + rs.status;
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
    if (req.method === 'GET' && req.url.startsWith('/api/probe-a')) {
        probeAHit += 1;
        receivedA = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"a":1}');
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/probe-b')) {
        probeBHit += 1;
        receivedB = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"b":1}');
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/submit')) {
        let body = '';
        req.on('data', (c) => {
            body += c;
        });
        req.on('end', () => {
            submitHit += 1;
            receivedSubmit = { headers: req.headers, body };
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
console.log(`本地服务已启动:${pageUrl}`);

const sessionOptions = {
    requestRules: {
        enabled: true,
        // 组合 b 的 body 改写:把 submit 的 JSON body 加一个 injected 字段(body 变长,触发 content-length 重算)
        rules: [{ urlPattern: '*/api/submit*', bodyType: 'json', set: { injected: 'yes' } }],
        requestHeaderRules: [
            // 组合 a:when 满足 → 注入 x-inject、删除 x-drop-me、保留 x-orig
            {
                urlPattern: '*/api/probe-a*',
                when: { 'x-orig': 'keep' },
                setHeaders: { 'x-inject': 'yes' },
                removeHeaders: ['x-drop-me'],
            },
            // when 门槛:要求 x-orig=keep,但 probe-b 实发 other → 不应改(x-inject-b 不应出现)
            {
                urlPattern: '*/api/probe-b*',
                when: { 'x-orig': 'keep' },
                setHeaders: { 'x-inject-b': 'yes' },
            },
            // 组合 b:无条件改 submit 的请求头,与上面 rules 的 body 改写合并成一次 continue
            {
                urlPattern: '*/api/submit*',
                setHeaders: { 'x-inject-s': 'yes' },
            },
        ],
    },
};

const macro = {
    name: 'request-header-replay-test',
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

const checks = [];
const assert = (cond, desc) => {
    checks.push({ ok: !!cond, desc });
};

assert(result && result.ok === true, 'result.ok===true(#done 出现,三请求都成功发出)');
assert(probeAHit >= 1 && probeBHit >= 1 && submitHit >= 1, '三个接口各被命中至少 1 次(经改写链路到达)');

// 组合 a(GET):set / remove / 保留
assert(receivedA && receivedA['x-inject'] === 'yes', 'set 生效:probe-a 收到 x-inject=yes');
assert(receivedA && receivedA['x-drop-me'] === undefined, 'remove 生效:probe-a 不含 x-drop-me(本自带却被删)');
assert(receivedA && receivedA['x-orig'] === 'keep', '未列头保留:probe-a 仍含 x-orig=keep(且证 when 命中)');

// when 门槛:probe-b 规则 when 不满足 → 不改
assert(receivedB && receivedB['x-inject-b'] === undefined, 'when 门槛:probe-b when 不满足,x-inject-b 未注入');
assert(receivedB && receivedB['x-orig'] === 'other', 'when 门槛:probe-b 原始 x-orig=other 原样保留');

// 组合 b(POST):body 改写 + 请求头改写 同时生效(一次 continue 合并;content-length 已剥离故 body 完整)
let submitBody = null;
try {
    submitBody = receivedSubmit ? JSON.parse(receivedSubmit.body) : null;
} catch {
    submitBody = null;
}
assert(submitBody && submitBody.injected === 'yes', '组合 b:submit 的 body 被 rules 改写(injected=yes)');
assert(submitBody && submitBody.page === 1, '组合 b:submit body 原字段 page=1 保留(证 content-length 剥离后 body 完整可解析)');
assert(
    receivedSubmit && receivedSubmit.headers['x-inject-s'] === 'yes',
    '组合 b:submit 的请求头同时被改写(x-inject-s=yes,证 body+headers 一次 continue 合并)'
);

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log(`命中次数:probe-a=${probeAHit} probe-b=${probeBHit} submit=${submitHit}`);
for (const c of checks) {
    console.log(`${c.ok ? '✅' : '❌'} ${c.desc}`);
}

const pass = checks.every((c) => c.ok);
if (pass) {
    console.log('\n✅ 回放端请求头改写全部通过(set/remove/保留 + when 门槛 + 组合 b body/头合并)。');
    process.exit(0);
} else {
    console.log('\n❌ 回放端请求头改写未达预期。');
    process.exit(1);
}
