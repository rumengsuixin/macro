// 回放端「只记录不修改」支路端到端自检:验证 context.on('request'/'requestfinished') 真能把
// 回放时发出的请求+响应记录进时间线 JSONL 文件。
// 起本地 http echo 服务(同源提供测试页,免 CORS):页面自动 fetch('POST /echo', json) 后插 #done。
// session 故意设 enabled:false、rules:[](证明 record 支路独立于改写门槛),仅开 record.enabled;
// MacroRunner 第 6 参传临时 timelinesDir;跑 [goto, waitForSelector('#done')] 后读时间线文件,
// 断言含 /echo 的 request 行(POST、reqBody 未截断)+ 同 id 的 response 行(status=200、timingMs 为数、mimeType 有值)。
// 用法:MACRO_HEADLESS=1 node scripts/verify-timeline-replay.mjs
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

const sentBody = JSON.stringify({ page: 1, size: 20, debug: true });

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>timeline-replay</title>
<div id="host">初始化…</div>
<script>
  fetch('/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: ${JSON.stringify(sentBody)}
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

// 临时时间线输出目录
const timelinesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-tl-'));

// 关键:enabled:false + rules:[] —— 证明 record 支路独立于改写门槛也能工作
const sessionOptions = {
    requestRules: {
        enabled: false,
        rules: [],
        record: { enabled: true, urlPattern: '*/echo*', includeBody: true },
    },
};

const macro = {
    name: 'timeline-replay-test',
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
    timelinesDir
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

// 给 requestfinished 的异步响应行一点落盘时间(run 返回时 POST 已完成,但响应行写在异步回调里)
await new Promise((r) => setTimeout(r, 300));

// 读取临时目录里的 timeline-replay-*.jsonl
const files = fs.readdirSync(timelinesDir).filter((f) => f.startsWith('timeline-replay-') && f.endsWith('.jsonl'));
let lines = [];
for (const f of files) {
    lines = lines.concat(
        fs
            .readFileSync(path.join(timelinesDir, f), 'utf-8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l))
    );
}

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('时间线文件:', files);
console.log('记录条数:', lines.length);

const reqLine = lines.find((l) => l.kind === 'request' && /\/echo/.test(l.url));
const respLine = reqLine ? lines.find((l) => l.kind === 'response' && l.id === reqLine.id) : null;

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
assert(!!reqLine, '记录到 /echo 的 request 行');
if (reqLine) {
    assert(reqLine.method === 'POST', 'request 行 method=POST(不限 POST 也能记,这里恰为 POST)');
    assert(reqLine.reqBody === sentBody, `reqBody 完整未截断(${reqLine.reqBody})`);
}
assert(!!respLine, '记录到同 id 的 response 行');
if (respLine) {
    assert(respLine.status === 200, 'response 行 status=200');
    assert(typeof respLine.timingMs === 'number', 'response 行 timingMs 为数值');
    assert(typeof respLine.mimeType === 'string' && respLine.mimeType.length > 0, 'response 行 mimeType 有值');
}
// 证明 record 独立于改写:发出的 body 未被改写(仍是原始 {page:1,size:20,debug:true})
if (reqLine) {
    const parsed = JSON.parse(reqLine.reqBody);
    assert(parsed.size === 20 && parsed.debug === true, '记录的是页面原始 body(改写关闭,size 仍 20、debug 仍在)');
}

// 清理临时目录
try {
    fs.rmSync(timelinesDir, { recursive: true, force: true });
} catch {
    /* 忽略 */
}

if (failed > 0) {
    console.log(`\n❌ 回放端时间线记录未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log('\n✅ 回放端时间线记录端到端通过:record 支路独立于改写门槛,请求+响应完整落盘。');
process.exit(0);
