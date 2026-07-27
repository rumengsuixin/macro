// 回放端「record 迁 CDP Network 域」通用性红线自检:验证迁移后仍保住
//  ① 全站覆盖:页面发多个 API 请求(/a /b)都进时间线(record.urlPattern:'*');
//  ③ 失败请求:连一个未监听端口(connection refused)→ CDP Network.loadingFailed → 时间线有 error 行;
//  ⑥ 竞态:成功请求的响应行在 responseReceived 就写(status/mime 齐全,不等 loadingFinished)。
// (被动无副作用④、请求体文本⑤已由 verify-timeline-replay 覆盖;弹窗覆盖②靠 per-page attach,与 saveBodies 一致。)
// 用法:MACRO_HEADLESS=1 node scripts/verify-record-network.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>record-network</title>
<div id="host">初始化…</div>
<script>
(async function(){
  try { await fetch('/a'); } catch (e) {}
  try { await fetch('/b'); } catch (e) {}
  // 连未监听端口 → connection refused(网络层失败,先于 CORS)→ loadingFailed
  try { await fetch('http://127.0.0.1:9/dead'); } catch (e) {}
  var d = document.createElement('div'); d.id='done'; d.textContent='完成'; document.body.appendChild(d);
})();
</script>`);
        return;
    }
    if (req.method === 'GET' && (req.url === '/a' || req.url === '/b')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`本地服务已启动:http://127.0.0.1:${port}/`);

const timelinesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-recnet-'));
const sessionOptions = {
    requestRules: {
        enabled: false,
        rules: [],
        record: { enabled: true, urlPattern: '*', includeBody: true }, // 全站
    },
};
const macro = {
    name: 'record-network-test',
    version: 1,
    steps: [
        { type: 'goto', url: `http://127.0.0.1:${port}/` },
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
    timelinesDir
);

let result;
try {
    result = await Promise.race([
        runner.run(macro),
        new Promise((_, reject) => setTimeout(() => reject(new Error('自检硬超时(30s)')), 30000)),
    ]);
} catch (err) {
    console.error('❌ 回放异常:', err.message);
    server.close();
    process.exit(1);
}
server.close();
await new Promise((r) => setTimeout(r, 300)); // 失败行异步落盘余量

const files = fs
    .readdirSync(timelinesDir)
    .filter((f) => f.startsWith('timeline-replay-') && f.endsWith('.jsonl'));
const lines = files.flatMap((f) =>
    fs
        .readFileSync(path.join(timelinesDir, f), 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
);

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed += 1;
    }
}

const reqOf = (re) => lines.find((l) => l.kind === 'request' && re.test(l.url));
const respOf = (req) => (req ? lines.find((l) => l.kind === 'response' && l.id === req.id) : null);

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok, ';记录条数:', lines.length);

assert(result && result.ok === true, '回放成功');

// ① 全站覆盖:/a /b 都记到,且响应行 status=200(⑥ 竞态:responseReceived 即写)
for (const p of ['/a', '/b']) {
    const rq = reqOf(new RegExp(`${p}(\\?|$)`));
    const rs = respOf(rq);
    assert(!!rq, `全站覆盖:记录到 ${p} 的 request 行`);
    assert(!!rs && rs.status === 200, `${p} 的 response 行 status=200(responseReceived 即写)`);
}

// 页面文档请求(GET /)也应记到(证明"全站",非仅 API)
assert(!!reqOf(new RegExp(`127\\.0\\.0\\.1:${port}/(\\?|$)`)), '全站覆盖:页面文档请求 GET / 也记到');

// ③ 失败请求:连未监听端口 → loadingFailed → response 行带 error、无 status
const deadReq = reqOf(/127\.0\.0\.1:9\/dead/);
const deadResp = respOf(deadReq);
assert(!!deadReq, '失败请求:记录到 /dead 的 request 行');
assert(
    !!deadResp && typeof deadResp.error === 'string' && deadResp.error.length > 0,
    `失败请求:response 行带 error(${deadResp && deadResp.error})`
);
assert(!!deadResp && deadResp.status === undefined, '失败请求:response 行无 status(未成功)');

try {
    fs.rmSync(timelinesDir, { recursive: true, force: true });
} catch {
    /* 忽略 */
}

if (failed > 0) {
    console.log(`\n❌ record CDP Network 通用性未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log('\n✅ record 迁 CDP Network 通用性通过:全站覆盖 + 失败请求(loadingFailed)+ 响应头即写,均不退化。');
process.exit(0);
