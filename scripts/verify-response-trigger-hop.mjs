// 回放端「响应触发 when 表达式:hop 从根切断连环重发」端到端自检。
//
// 目的:证明 responseTrigger.when 里的 `hop == 0` 只在**真实浏览器响应**触发重发,
//       工具自身重发引发的响应(hop≥1)一律不再触发下一跳——连环从**源头**断掉,
//       而**不是**靠 maxResendHops=5 兜底熔断。
//
// 制造潜在连环(关键设计):
//  - urlPattern 捕获 POST /job(页面加载时发,hop0);
//  - responseTrigger.triggerUrl = '*/status*';setUrl 把重发目标整体覆盖为 /status。
//    → 于是**重发自身**(POST /status)的响应也匹配 triggerUrl,构成「重发 → 又触发 → 再重发」的潜在连环。
//  - 若无 when:GET /status(hop0)触发 → POST /status(hop1)响应又触发 → POST /status(hop2)… 连环到
//    maxResendHops=5 才熔断(重发数≈5)。
//  - 有 when:'hop == 0':真实 GET /status(hop0)满足 → 重发 1 次;该重发 POST /status 的响应(hop1)
//    when 不满足 → **不再触发**,重发数恒为 1。且 handleResponseTrigger 的 hop 熔断(hop≥5)此处根本没到,
//    证明断链是 when 判的、不是 maxResendHops 兜的。
//
// 断言:①回放成功;②POST /job 原始捕获发生;③重发恰 1 次(POST /status,hop=1,body 为捕获的 {seq:'J'});
//       ④日志出现 `when 条件不满足:hop == 0(status=200, hop=1)`(证明 hop1 响应被 when 挡下);
//       ⑤再等 2s 重发数不增长(无连环)。
// 用法:MACRO_HEADLESS=1 node scripts/verify-response-trigger-hop.mjs
//   缺 headless_shell 时:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright MACRO_HEADLESS=1 node ...
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const DELAY_MS = 300;

/** 页面发的原始 POST /job:{ seq, ts } */
const jobHits = [];
/** 重发落点 POST /status:{ hop(x-macro-resend 跳数), seq, ts } */
const resendHits = [];

// 捕获 runner 的中文日志,用于断言「hop 未命中」诊断
const logLines = [];
const origLog = console.log;
console.log = (...a) => {
    logLines.push(a.join(' '));
    origLog(...a);
};

// 触发响应体(when 只判 hop,不读体;这里给个简单 JSON 即可)
const STATUS_BODY = JSON.stringify({ state: 'done' });

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // 先发被捕获的 /job,再发真实触发用的 GET /status(hop0)
        res.end(`<!doctype html><meta charset="utf-8"><title>hop-cut</title>
<div id="host">running</div>
<script>
  fetch('/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seq: 'J' })
  }).catch(function () {}).then(function () {
    fetch('/status').catch(function () {});
  });
</script>`);
        return;
    }
    // 原始捕获落点:POST /job
    if (req.method === 'POST' && req.url.startsWith('/job')) {
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
            jobHits.push({ seq: body && body.seq, ts: Date.now() });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
        return;
    }
    // /status:GET = 真实触发(hop0);POST = 重发落点(带 x-macro-resend 跳数)。两者都返回 200 触发响应。
    if (req.url.startsWith('/status')) {
        if (req.method === 'POST') {
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
                resendHits.push({
                    hop: parseInt(req.headers['x-macro-resend'] || '0', 10),
                    seq: body && body.seq,
                    ts: Date.now(),
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(STATUS_BODY);
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(STATUS_BODY);
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;
console.log(`本地服务已启动:${pageUrl}`);

// onPause:保活直到「≥1 原始 job + ≥1 重发」出现(再由主流程等 2s 观察不增长)
const onPause = () =>
    new Promise((resolve) => {
        const iv = setInterval(() => {
            if (jobHits.length >= 1 && resendHits.length >= 1) {
                clearInterval(iv);
                resolve();
            }
        }, 100);
    });

fs.mkdirSync(path.join(root, 'errors'), { recursive: true });
const session = {
    requestRules: {
        enabled: true,
        rules: [],
        resends: [
            {
                urlPattern: '*/job*',
                responseTrigger: {
                    triggerUrl: '*/status*',
                    // 核心:只在真实响应(hop==0)触发;任何重发引发的响应(hop≥1)一律不触发 → 从根断链
                    when: 'hop == 0',
                },
                // 重发目标整体覆盖为 /status → 重发自身的响应也匹配 triggerUrl,构成潜在连环(靠 when 切断)
                setUrl: `http://127.0.0.1:${port}/status`,
                delayMs: DELAY_MS,
                repeat: 1,
            },
        ],
    },
};
const runner = new MacroRunner(path.join(root, 'errors'), undefined, onPause, session);

const macro = {
    name: 'resp-trigger-hop-cut-test',
    version: 1,
    steps: [
        { type: 'goto', url: pageUrl },
        { type: 'pause' },
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

// 再等 2s,验证 hop1 响应不会连环触发(重发数应保持 == 1)
await new Promise((r) => setTimeout(r, 2000));
server.close();

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('POST /job 原始 =', jobHits.length, '| 重发 POST /status =', resendHits.length);
console.log('重发跳数分布 =', JSON.stringify(resendHits.map((r) => r.hop)));

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
assert(jobHits.length >= 1, `POST /job 原始捕获发生(实际 ${jobHits.length})`);
assert(resendHits.length === 1, `重发恰 1 次(实际 ${resendHits.length})`);
assert(resendHits[0] && resendHits[0].hop === 1, `重发请求带跳数 hop=1(实际 ${resendHits[0] && resendHits[0].hop})`);
assert(resendHits[0] && resendHits[0].seq === 'J', '重发的是捕获的 /job 请求(body seq=J)');
// 核心可观测点:hop1 的 /status 响应被 when 挡下,打出带实际 hop 的未命中诊断
const missHopLine = logLines.find(
    (l) => /未命中 \[\*\/job\*\]/.test(l) && /when 条件不满足:hop == 0/.test(l) && /hop=1/.test(l)
);
assert(!!missHopLine, '日志出现 `when 条件不满足:hop == 0(status=200, hop=1)`(证明 hop1 响应被 when 挡)');
assert(resendHits.length === 1, `连环被 when 从根切断:重发数恒为 1、不增长(实际 ${resendHits.length})`);

if (failed > 0) {
    console.log(`\n❌ hop 断链自检未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log(
    '\n✅ 回放端「when hop==0 从根切断连环」通过:真实响应(hop0)触发 1 次重发,重发自身响应(hop1)被 when 挡下、不再连环,未依赖 maxResendHops 兜底。'
);
process.exit(0);
