// 回放端「挂起 + 人工放行(blocks mode:'hold')」端到端自检:
// 验证命中 mode:'hold' 的请求被回放引擎挂起(pending,不发也不失败),await 注入的 onHold 回调,
// 按其返回的处置(continue/abort)分别 route.continue()(放行到达)/ route.abort()(丢弃不到达)。
//
// 组成:
//   ① 离线:写一份临时 request-rules.json(hold / abort / 非法 mode 各一条),经 loadRequestRules 归一化,
//      断言 mode 白名单——'hold' 保留、缺省与非法回退 undefined(即 abort 语义)。
//   ② E2E-continue:blocks:[{urlPattern:'*/held*', mode:'hold'}],onHold 断言「决定时刻服务端尚未收到 /held」
//      (证明确实挂起)后返回 'continue';断言 /held 最终到达服务端、回放 ok。
//   ③ E2E-abort:同规则,onHold 返回 'abort';断言 /held 从未到达服务端、页面侧 fetch 被拒。
//
// 用法:MACRO_HEADLESS=1 node scripts/verify-block-hold.mjs
//   本机缺 headless_shell 时前置 PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const { loadRequestRules } = require('../dist/storage/request-rules-store.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let failed = false;
const check = (cond, okMsg, badMsg) => {
    if (cond) {
        console.log('  ✅', okMsg);
    } else {
        console.log('  ❌', badMsg);
        failed = true;
    }
};

// ========== ① 离线:normalizeBlockRule 的 mode 白名单 ==========
console.log('\n[1] 离线:blocks 规则 mode 归一化');
{
    const tmp = path.join(os.tmpdir(), `req-rules-hold-${process.pid}.json`);
    fs.writeFileSync(
        tmp,
        JSON.stringify({
            enabled: true,
            rules: [],
            blocks: [
                { urlPattern: '*/a*', mode: 'hold' }, // 保留
                { urlPattern: '*/b*' }, // 缺省 → undefined(abort 语义)
                { urlPattern: '*/c*', mode: 'nonsense' }, // 非法 → undefined
            ],
        })
    );
    const cfg = loadRequestRules(tmp);
    fs.rmSync(tmp, { force: true });
    const blocks = cfg.blocks || [];
    check(blocks.length === 3, '三条 block 规则均保留', `block 规则数异常:${blocks.length}`);
    check(blocks[0]?.mode === 'hold', "mode:'hold' 被保留", `第 1 条 mode 期望 hold,实际 ${blocks[0]?.mode}`);
    check(blocks[1]?.mode === undefined, '缺省 mode 归一为 undefined(abort)', `第 2 条 mode 应为 undefined,实际 ${blocks[1]?.mode}`);
    check(blocks[2]?.mode === undefined, '非法 mode 回退 undefined(abort)', `第 3 条 mode 应为 undefined,实际 ${blocks[2]?.mode}`);
}

// ========== 本地 echo 服务(②③ 共用) ==========
const hits = new Set();
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>block-hold</title>
<div id="host">初始化…</div>
<script>
  var results = {};
  Promise.allSettled([
    fetch('/allowed').then(function () { results.allowed = 'ok'; },
                           function (e) { results.allowed = 'err:' + String(e); }),
    fetch('/held').then(function () { results.held = 'ok'; },
                        function (e) { results.held = 'err:' + String(e); })
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
    if (req.method === 'GET' && (req.url === '/held' || req.url.startsWith('/held?'))) {
        hits.add('/held');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('held-arrived');
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;
console.log(`\n本地 echo 服务已启动:${pageUrl}`);

const sessionOptions = {
    requestRules: {
        enabled: true,
        rules: [],
        blocks: [{ urlPattern: '*/held*', mode: 'hold' }],
    },
};
const macro = {
    name: 'block-hold-test',
    version: 1,
    steps: [
        { type: 'goto', url: pageUrl },
        { type: 'waitForSelector', selector: '#done', timeout: 15000 },
    ],
};

fs.mkdirSync(path.join(root, 'errors'), { recursive: true });

// 跑一次回放:decision = onHold 对 /held 请求返回的处置;返回本次运行结果 + 决定时刻是否已到达服务端
async function runOnce(decision) {
    hits.clear();
    let heldSeenAtDecision = null;
    const runner = new MacroRunner(path.join(root, 'errors'), undefined, undefined, sessionOptions);
    runner.setOnHold(async (info) => {
        // 只对 /held 记录快照;决定时刻服务端不应已收到(证明请求被真正挂起、尚未发出)
        if (info.url.includes('/held')) {
            heldSeenAtDecision = hits.has('/held');
        }
        return decision;
    });
    const result = await Promise.race([
        runner.run(macro),
        new Promise((_, reject) => setTimeout(() => reject(new Error('自检硬超时(30s)')), 30000)),
    ]);
    return { result, heldSeenAtDecision };
}

// ========== ② hold → continue ==========
console.log("\n[2] E2E:mode:'hold' → 人工 continue(放行)");
try {
    const { result, heldSeenAtDecision } = await runOnce('continue');
    check(result?.ok === true, '回放成功完成', `回放未成功:${result?.error?.message}`);
    check(heldSeenAtDecision === false, '决定时刻 /held 尚未到达服务端(确已挂起)', `挂起时机异常:heldSeenAtDecision=${heldSeenAtDecision}`);
    check(hits.has('/allowed') === true, '/allowed 正常放行到达', '/allowed 未到达');
    check(hits.has('/held') === true, 'continue 后 /held 到达服务端', 'continue 后 /held 仍未到达');
} catch (err) {
    console.log('  ❌ 回放异常:', err.message);
    failed = true;
}

// ========== ③ hold → abort ==========
console.log("\n[3] E2E:mode:'hold' → 人工 abort(丢弃)");
try {
    const { result, heldSeenAtDecision } = await runOnce('abort');
    check(result?.ok === true, '回放成功完成(被丢弃的 fetch 也已 settle)', `回放未成功:${result?.error?.message}`);
    check(heldSeenAtDecision === false, '决定时刻 /held 尚未到达服务端(确已挂起)', `挂起时机异常:heldSeenAtDecision=${heldSeenAtDecision}`);
    check(hits.has('/allowed') === true, '/allowed 正常放行到达', '/allowed 未到达');
    check(hits.has('/held') === false, 'abort 后 /held 从未到达服务端', 'abort 后 /held 仍到达(未被丢弃)');
} catch (err) {
    console.log('  ❌ 回放异常:', err.message);
    failed = true;
}

server.close();

console.log('\n========== 验证结果 ==========');
if (failed) {
    console.log('❌ 挂起放行自检未全部通过。');
    process.exit(1);
}
console.log('✅ blocks mode:\'hold\' 挂起放行生效:continue 放行到达、abort 丢弃不到达、决定前请求确被挂起。');
process.exit(0);
