// 回放端「响应条件触发重发(捕获-重放模型)」端到端自检。
//
// 新模型:urlPattern = 要捕获并重发的请求;responseTrigger.triggerUrl = 监听触发用的响应;无 targetUrl。
//  即「捕获 urlPattern 请求 → 当 triggerUrl 的响应满足 status/headers/bodyJson(AND)时,重发捕获的请求」。
//
// 设计(triggerUrl 响应用**深层嵌套+异构数组**结构,靠 bodyContains 原文子串匹配——点路径写不出的场景):
//  - 本地服务:GET / 返回测试页,加载后**先** POST /payload(body {seq:"B"},被 urlPattern 捕获),
//    **再** GET /status?case=pending 与 GET /status?case=done;/status 响应复刻 YouTube 上传反馈结构
//    (continuationContents[0].uploadFeedbackItemContinuation.contents[0].transferProgressBar.fractionCompleted),
//    done=1/「已上传 100%。」,pending=0.5/「已上传 50%。」,响应头 x-ready:1。
//  - POST /payload 记录 { body, resent:!!x-macro-resend, ts }。
//  - session:enabled:true、rules:[]、resends:[{ urlPattern:'*/payload*',
//      responseTrigger:{ triggerUrl:'*/status*', status:200, headers:{'x-ready':'1'},
//                        requestHeaders:{'x-phase':'final'},
//                        bodyContains:['uploadFeedbackItemContinuation','"fractionCompleted":1'] },
//      delayMs:800, repeat:1 }]。
//  - 三个 /status 触发请求:pending(x-phase:final,body 0.5)、done(x-phase:final,body 1)、
//      badhdr(x-phase:wrong,body 1)——分别验证 body 门槛、全满足触发、请求头门槛。
//  - done 响应带响应头 x-goog-session-id:sid-xyz;规则用 extract 取「响应头值 + 响应体点路径值」→
//      经 {{sid}}/{{fid}} 注入重发的 setHeaders(x-injected-sid)、set(body.injected_fid)与
//      setUrl(重发目标 URL 整体覆盖为 /resend-target?fid=…&sid=…),验证请求头/请求体/URL 三处动态注入。
//  - 宏 = [goto, pause];onPause 轮询「≥1 原始 payload && ≥1 重发 payload」才 resolve。
// 断言:①/payload 恰 1 原始(resent=false);②恰 1 重发(resent=true、body seq=B 证重发的是捕获的 B);
//       ③pending 响应不触发(body 门槛)、badhdr 不触发(requestHeaders 门槛)、只有 done 触发;
//       ④延时≈800ms;⑤重发数==1 不增长(重发的 /payload 响应不匹配 triggerUrl 且带标记头 → 不递归);
//       ⑥pending 打 body 未命中诊断、badhdr 打请求头未命中诊断;
//       ⑦重发请求头 x-injected-sid==sid-xyz(响应头提取注入)、重发 body.injected_fid==innertube_studio:X:0
//         (响应体点路径提取注入)、原始 /payload 不带注入头(注入只发生在重发);
//       ⑧重发命中 setUrl 覆盖的 /resend-target 端点、且 URL 查询含注入的提取值(证明 URL 也能注入)。
// 用法:MACRO_HEADLESS=1 node scripts/verify-response-trigger-replay.mjs
//   缺 headless_shell 时:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright MACRO_HEADLESS=1 node ...
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const DELAY_MS = 800;

/** 服务端收到的每个 /payload:{ body(已解析), resent(是否带标记头), ts } */
const payloadHits = [];

// 捕获 runner 的中文日志(logInfo → console.log),用于断言「未命中原因」诊断日志
const logLines = [];
const origLog = console.log;
console.log = (...a) => {
    logLines.push(a.join(' '));
    origLog(...a);
};

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // 先发要被捕获的 /payload,再发两个触发用 /status(pending 不满足、done 满足)
        res.end(`<!doctype html><meta charset="utf-8"><title>resp-trigger</title>
<div id="host">running</div>
<script>
  fetch('/payload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seq: 'B' })
  }).catch(function () {}).then(function () {
    // pending:请求头达标(x-phase:final)但 body 未到 100% → 被 bodyContains 挡
    fetch('/status?case=pending', { headers: { 'x-phase': 'final' } }).catch(function () {});
    // done:请求头 x-phase:final + body 100% → 全 AND 满足,触发重发
    fetch('/status?case=done', { headers: { 'x-phase': 'final' } }).catch(function () {});
    // badhdr:body 到 100% 但请求头 x-phase:wrong → 被 requestHeaders 挡(证请求头门控独立生效)
    fetch('/status?case=badhdr', { headers: { 'x-phase': 'wrong' } }).catch(function () {});
  });
</script>`);
        return;
    }
    // 兼容两个落点:原捕获请求 /payload、以及被 setUrl 整体覆盖后的重发目标 /resend-target
    if (req.method === 'POST' && (req.url.startsWith('/payload') || req.url.startsWith('/resend-target'))) {
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
            payloadHits.push({
                body,
                // 落点 URL:验证 setUrl 是否把重发导到 /resend-target 且 URL 含注入的提取值
                url: req.url,
                resent: !!req.headers['x-macro-resend'],
                // 提取注入验证:重发请求头里被注入的 sid(原始请求不带,重发时经 {{sid}} 注入)
                injectedSid: req.headers['x-injected-sid'],
                ts: Date.now(),
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/status')) {
        // 复刻 YouTube 上传反馈那种深层嵌套 + 异构数组结构:点路径难写,靠 bodyContains 原文子串匹配
        const done = !req.url.includes('case=pending');
        const frac = done ? 1 : 0.5;
        const pct = done ? '已上传 100%。' : '已上传 50%。';
        // 提取注入验证:done 触发响应带一个自定义响应头,供 extract.fromHeader 取值注入重发请求头
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'x-ready': '1',
            'x-goog-session-id': 'sid-xyz',
        });
        res.end(
            JSON.stringify({
                continuationContents: [
                    {
                        uploadFeedbackItemContinuation: {
                            id: { a: 'innertube_studio:X:0' },
                            contents: [
                                {
                                    transferProgressBar: {
                                        fractionCompleted: frac,
                                        progressMessage: { simpleText: pct },
                                    },
                                },
                            ],
                        },
                    },
                ],
            })
        );
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;
console.log(`本地服务已启动:${pageUrl}`);

// onPause:保活直到「≥1 原始 payload + ≥1 重发 payload」
const onPause = () =>
    new Promise((resolve) => {
        const iv = setInterval(() => {
            const original = payloadHits.filter((r) => !r.resent);
            const resent = payloadHits.filter((r) => r.resent);
            if (original.length >= 1 && resent.length >= 1) {
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
                urlPattern: '*/payload*',
                responseTrigger: {
                    triggerUrl: '*/status*',
                    status: 200,
                    headers: { 'x-ready': '1' },
                    // requestHeaders:门控 triggerUrl 那条 /status 请求的头(x-phase=final);badhdr 用 wrong 会被挡
                    requestHeaders: { 'x-phase': 'final' },
                    // bodyContains:免路径原文子串匹配深层嵌套/数组(点路径写不出 transferProgressBar 的位置)
                    bodyContains: ['uploadFeedbackItemContinuation', '"fractionCompleted":1'],
                    // extract:从触发响应取值 → 命名变量,供下方 setHeaders/set 用 {{占位符}} 注入重发
                    extract: {
                        sid: { fromHeader: 'x-goog-session-id', default: 'NOSID' },
                        fid: {
                            fromBody: 'continuationContents.0.uploadFeedbackItemContinuation.id.a',
                        },
                    },
                },
                // 注入验证:请求头 x-injected-sid ← {{sid}}(响应头值);body 加 injected_fid ← {{fid}}(响应体点路径值)
                setHeaders: { 'x-injected-sid': '{{sid}}' },
                set: { injected_fid: '{{fid}}' },
                // setUrl 注入验证:重发目标 URL 整体覆盖为 /resend-target,并用 {{fid}}/{{sid}} 拼进查询,
                // 证明 URL 也能注入 extract 值(${port} 是 Node 端口插值,{{}} 才是 renderTemplate 占位符)
                setUrl: `http://127.0.0.1:${port}/resend-target?fid={{fid}}&sid={{sid}}`,
                delayMs: DELAY_MS,
                repeat: 1,
            },
        ],
    },
};
const runner = new MacroRunner(path.join(root, 'errors'), undefined, onPause, session);

const macro = {
    name: 'resp-trigger-capture-test',
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

// 再等 2s,验证不会自触发递归(重发数应保持 == repeat=1)
await new Promise((r) => setTimeout(r, 2000));
server.close();

const original = payloadHits.filter((r) => !r.resent);
const resent = payloadHits.filter((r) => r.resent);

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('/payload 总数 =', payloadHits.length, '| 原始 =', original.length, '| 重发 =', resent.length);
if (resent[0]) console.log('重发 body =', JSON.stringify(resent[0].body));
if (original[0] && resent[0]) {
    console.log('重发延时(ms) ≈', resent[0].ts - original[0].ts, `(配置 ${DELAY_MS})`);
}

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
assert(original.length === 1, `/payload 恰有 1 原始(实际 ${original.length})`);
assert(resent.length === 1, `/payload 恰有 1 重发(实际 ${resent.length})`);
assert(
    resent[0] && resent[0].body && resent[0].body.seq === 'B',
    '重发的是捕获的 /payload 请求(body seq=B)'
);
// 提取注入:响应头值 sid-xyz 经 {{sid}} 注入到重发请求头 x-injected-sid
assert(
    resent[0] && resent[0].injectedSid === 'sid-xyz',
    '重发请求头 x-injected-sid == "sid-xyz"(从触发响应头提取注入)'
);
// 提取注入:响应体点路径值经 {{fid}} 注入到重发 body 的 injected_fid
assert(
    resent[0] && resent[0].body && resent[0].body.injected_fid === 'innertube_studio:X:0',
    '重发 body.injected_fid == "innertube_studio:X:0"(从触发响应体点路径提取注入)'
);
// setUrl 注入:重发目标 URL 被整体覆盖为 /resend-target(而非发回原捕获的 /payload)
assert(
    resent[0] && typeof resent[0].url === 'string' && resent[0].url.startsWith('/resend-target'),
    '重发命中 setUrl 指定的独立端点 /resend-target(证明重发 URL 被整体覆盖)'
);
// setUrl 注入:URL 查询里含经 {{fid}}/{{sid}} 注入的提取值
assert(
    resent[0] && /fid=innertube_studio/.test(resent[0].url) && /sid=sid-xyz/.test(resent[0].url),
    '重发 URL 查询含注入的提取值(fid=innertube_studio…&sid=sid-xyz)'
);
// 原始 /payload 不带注入头,证明注入只发生在重发上
assert(
    original[0] && original[0].injectedSid === undefined,
    '原始 /payload 不含 x-injected-sid(注入只发生在重发)'
);
assert(
    original[0] && resent[0] && resent[0].ts - original[0].ts >= DELAY_MS - 300,
    `重发延时 ≥ ${DELAY_MS - 300}ms(证 done 响应满足条件后延时重发)`
);
assert(
    resent.length === 1,
    `重发数 == repeat(=1)不增长(pending 未触发 + 防递归,实际 ${resent.length})`
);
// pending(fractionCompleted:0.5)响应会打一条「未命中原因」诊断日志(body 差异)
const missBodyLine = logLines.find((l) => /未命中 \[\*\/payload\*\]/.test(l) && l.includes('"fractionCompleted":1'));
assert(!!missBodyLine, 'pending 响应打出未命中诊断日志(缺 "fractionCompleted":1)');
// badhdr(body 达标但请求头 x-phase:wrong)会打一条请求头未命中诊断
const missHdrLine = logLines.find((l) => /未命中 \[\*\/payload\*\]/.test(l) && /请求头 x-phase 期望 "final" 实际 "wrong"/.test(l));
assert(!!missHdrLine, 'badhdr 响应打出请求头未命中诊断(请求头 x-phase 期望 "final" 实际 "wrong")');
assert(
    resent.length === 1,
    `请求头门控生效:badhdr(body 达标但请求头不符)未额外触发重发,重发数仍为 1(实际 ${resent.length})`
);

if (failed > 0) {
    console.log(`\n❌ 响应触发(捕获-重放)未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log(
    '\n✅ 回放端「响应条件触发重发(捕获-重放)」通过:捕获 urlPattern 请求 → triggerUrl 响应满足条件才重发捕获的请求,pending(body)/badhdr(请求头)被门槛挡掉、防递归。'
);
process.exit(0);
