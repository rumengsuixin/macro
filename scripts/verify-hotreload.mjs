// 回放端「运行中热更新」端到端自检:验证回放跑到一半 updateRequestRules 后,改写与记录都能 off→on。
//
// 确定性设计(避开无头页面定时器节流 + 浏览器冷启动时机不稳 + #done 检测繁琐):
//  - 页面用**链式 fetch**:上一个 POST 的响应回来才发下一个,节奏由服务器响应延迟(300ms)决定,
//    不依赖会被无头节流的 setInterval/setTimeout;持续 POST 不停。
//  - 宏 = [goto, pause];注入的 **onPause 回调**轮询 received.length,收满 TARGET 个 POST 才 resolve
//    让 pause 结束、宏正常收尾(run.ok=true)——不依赖页面 DOM/#done/定时器,最稳。
//  - toggle 由 **Node 侧轮询 received.length** 触发:收到第 3 个 POST 后调 runner.updateRequestRules
//    切到「改写+记录全开」——与浏览器启动耗时无关,分界确定(前 3 个未改/未记,其后已改/已记)。
// 断言:①received 里既有早期未改写 body(无 injected)、又有后期改写 body(injected=yes);
//      ②timeline 的 request 行数 ≥1 且 < 总 POST 数(早期未记、后期已记)。
// 说明:直接驱动 runner.updateRequestRules(测 core 新逻辑);main.ts 的 fs.watchFile 是机械 glue(复刻录制端)。
// 用法:MACRO_HEADLESS=1 node scripts/verify-hotreload.mjs
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

const TARGET = 8; // 页面共发这么多 POST 后插 #done
const TOGGLE_AFTER = 3; // 收到第几个 POST 后热更新(前 TOGGLE_AFTER 个保持未改/未记)

/** 服务端收到的每个 POST body(已解析,按到达顺序) */
const received = [];

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // 链式 fetch:上一个响应回来才发下一个(服务器定速),持续 POST 不停(由 onPause 侧决定何时结束)
        res.end(`<!doctype html><meta charset="utf-8"><title>hotreload</title>
<div id="host">running</div>
<script>
  function loop() {
    fetch('/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 1, size: 20, debug: true })
    }).then(loop).catch(function () { setTimeout(loop, 200); });
  }
  loop();
</script>`);
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/echo')) {
        let data = '';
        req.on('data', (c) => {
            data += c;
        });
        req.on('end', () => {
            try {
                received.push(JSON.parse(data));
            } catch {
                received.push({ _raw: data });
            }
            // 定速 300ms 再响应(客户端收到才发下一个),节奏与页面定时器无关
            setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            }, 300);
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

const timelinesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-hr-'));

// 初始:改写 + 记录都关
const initialSession = {
    requestRules: { enabled: false, rules: [], record: { enabled: false } },
};

// onPause:保持回放存活,直到服务端收满 TARGET 个 POST 才 resolve(让 pause 结束、宏正常收尾)
const onPause = () =>
    new Promise((resolve) => {
        const iv = setInterval(() => {
            if (received.length >= TARGET) {
                clearInterval(iv);
                resolve();
            }
        }, 100);
    });

fs.mkdirSync(path.join(root, 'errors'), { recursive: true });
const runner = new MacroRunner(
    path.join(root, 'errors'),
    undefined,
    onPause,
    initialSession,
    undefined,
    timelinesDir
);

const macro = {
    name: 'hotreload-test',
    version: 1,
    steps: [
        { type: 'goto', url: pageUrl },
        { type: 'pause' }, // onPause 轮询到 TARGET 个 POST 后放行,宏收尾
    ],
};

// 中途热更新:收到第 TOGGLE_AFTER 个 POST 后,切到「改写 size→100/injected=yes/删 debug」+「记录 /echo」
const hotCfg = {
    enabled: true,
    rules: [
        {
            urlPattern: '*/echo*',
            bodyType: 'json',
            set: { size: 100, injected: 'yes' },
            remove: ['debug'],
        },
    ],
    record: { enabled: true, urlPattern: '*/echo*', includeBody: true },
};
let toggled = false;
const toggleWatcher = setInterval(() => {
    if (!toggled && received.length >= TOGGLE_AFTER) {
        toggled = true;
        console.log(`[收到第 ${received.length} 个 POST] 热更新:开启改写 + 记录`);
        runner.updateRequestRules(hotCfg);
        clearInterval(toggleWatcher);
    }
}, 80);

let result;
try {
    result = await Promise.race([
        runner.run(macro),
        new Promise((_, reject) => setTimeout(() => reject(new Error('自检硬超时(45s)')), 45000)),
    ]);
} catch (err) {
    clearInterval(toggleWatcher);
    console.log('❌ 回放异常:', err.message);
    server.close();
    process.exit(1);
}
clearInterval(toggleWatcher);
server.close();

// 给记录响应行一点落盘时间
await new Promise((r) => setTimeout(r, 300));

// 读时间线
const tlFiles = fs
    .readdirSync(timelinesDir)
    .filter((f) => f.startsWith('timeline-replay-') && f.endsWith('.jsonl'));
let tlLines = [];
for (const f of tlFiles) {
    tlLines = tlLines.concat(
        fs
            .readFileSync(path.join(timelinesDir, f), 'utf-8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l))
    );
}
const recordedReqs = tlLines.filter((l) => l.kind === 'request' && /\/echo/.test(l.url));

const early = received.filter((b) => b.size === 20 && b.injected === undefined);
const late = received.filter((b) => b.size === 100 && b.injected === 'yes' && b.debug === undefined);

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('总 POST 数 =', received.length, '| 未改写 =', early.length, '| 已改写 =', late.length);
console.log('时间线文件 =', tlFiles, '| 记录到的 /echo 请求行 =', recordedReqs.length);

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
assert(received.length >= TOGGLE_AFTER + 2, `期间发生了足够多的 POST(${received.length} 次)`);
assert(early.length >= 1, '改写 off→on:热更新前的 POST 未被改写(size=20、无 injected)');
assert(late.length >= 1, '改写 off→on:热更新后的 POST 已被改写(size=100、injected=yes、删 debug)');
assert(recordedReqs.length >= 1, '记录 off→on:热更新后有 /echo 请求被记录');
assert(
    recordedReqs.length < received.length,
    `记录 off→on:早期 POST 未记录(记录 ${recordedReqs.length} < 总 ${received.length})`
);

try {
    fs.rmSync(timelinesDir, { recursive: true, force: true });
} catch {
    /* 忽略 */
}

if (failed > 0) {
    console.log(`\n❌ 运行中热更新未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log('\n✅ 回放端运行中热更新通过:改写与记录都能在回放跑到一半时 off→on 生效。');
process.exit(0);
