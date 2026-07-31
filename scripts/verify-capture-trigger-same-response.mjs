// 回放端「captures 与 responseTrigger 命中同一响应」时序回归自检(端到端)。
//
// 复刻线上坑:变量捕获(captures)与响应条件触发重发(resends.responseTrigger)挂在**同一条响应**上——
//  真实场景是 YouTube 上传里 upload/studio 的 active 响应既带 x-goog-upload-header-scotty-resource-id
//  (captures 从这里取 scottyResourceId 入变量池),又是 createvideo 重发的触发闸门(responseTrigger)。
//  旧实现两个 context.on('response') 监听器 trigger 先注册、capture 后注册,同步派发下 trigger 抢在 capture
//  写变量池之前读到空池 → 重发注入空值。修复:合并成一条监听、链式 await(先 capture 后 trigger)。
//
// 设计(最小复刻,全走响应头、无需读体,恰是旧实现必翻车的形态):
//  - 本地服务:GET / 返回页面,加载后**先** POST /createvideo(body {seq:'A', resourceId:'PLACEHOLDER'},
//    被 resend urlPattern 捕获),await 后**再** GET /studio。
//  - GET /studio 响应头带 { 'x-ready':'1', 'x-scotty': REAL_SCOTTY };body 为空对象(捕获与触发都只看响应头)。
//  - captures:命中 */studio* 且 header('x-ready')=='1' → 从响应头 x-scotty 提取 scottyResourceId 入变量池。
//  - resends:urlPattern */createvideo*,responseTrigger.triggerUrl */studio* + headers x-ready:1,
//    set { resourceId: '{{scottyResourceId}}' } → 用捕获到的变量整体替换 body.resourceId。
//  - 宏 = [goto, pause];onPause 轮询「≥1 原始 createvideo && ≥1 重发 createvideo」才 resolve。
// 断言:①恰 1 原始 createvideo;②恰 1 重发;③**重发 body.resourceId == REAL_SCOTTY(非空、非占位符)**——
//        这是回归锚点:旧实现顺序输赢会注入空值,此断言必失败;修复后必通过;
//       ④命中 captures 的变量池更新日志出现;⑤**不出现**「scottyResourceId 尚未捕获到 … 将注入空值」告警。
// 用法:MACRO_HEADLESS=1 node scripts/verify-capture-trigger-same-response.mjs
//   缺 headless_shell 时:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright MACRO_HEADLESS=1 node ...
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const REAL_SCOTTY = 'ACK-REAL-SCOTTY-9999';

/** 服务端收到的每个 /createvideo:{ body(已解析), resent(是否带标记头), ts } */
const createHits = [];

// 捕获 runner 的中文日志,用于断言「变量池更新」与「不出现空值告警」
const logLines = [];
const origLog = console.log;
console.log = (...a) => {
    logLines.push(a.join(' '));
    origLog(...a);
};

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // 先发要被捕获的 /createvideo,await 后再发触发用 /studio(保证重发目标已被捕获)
        res.end(`<!doctype html><meta charset="utf-8"><title>cap-trigger-same</title>
<div id="host">running</div>
<script>
  fetch('/createvideo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seq: 'A', resourceId: 'PLACEHOLDER' })
  }).catch(function () {}).then(function () {
    // /studio:captures 从这条响应头取 scottyResourceId,同时它又是 createvideo 重发的触发闸门(同一响应)
    fetch('/studio').catch(function () {});
  });
</script>`);
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/createvideo')) {
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
            createHits.push({
                body,
                resent: !!req.headers['x-macro-resend'],
                ts: Date.now(),
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/studio')) {
        // 同一响应:响应头既供 captures 提取(x-scotty),又满足 responseTrigger 门槛(x-ready:1)
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'x-ready': '1',
            'x-scotty': REAL_SCOTTY,
        });
        res.end('{}');
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;
console.log(`本地服务已启动:${pageUrl}`);

// onPause:保活直到「≥1 原始 createvideo + ≥1 重发 createvideo」
const onPause = () =>
    new Promise((resolve) => {
        const iv = setInterval(() => {
            const original = createHits.filter((r) => !r.resent);
            const resent = createHits.filter((r) => r.resent);
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
        // 被动变量捕获:命中 */studio* 且响应头 x-ready==1 → 从响应头 x-scotty 取 scottyResourceId 入变量池
        captures: [
            {
                urlPattern: '*/studio*',
                when: "header('x-ready') == '1'",
                extract: {
                    scottyResourceId: { fromHeader: 'x-scotty' },
                },
            },
        ],
        // 响应条件触发重发:捕获 */createvideo* 请求;当 */studio* 响应(同一条)满足 x-ready:1 → 重发,
        // set 用 {{scottyResourceId}} 整体替换 body.resourceId(值来自上面 captures 写入的变量池)
        resends: [
            {
                urlPattern: '*/createvideo*',
                responseTrigger: {
                    triggerUrl: '*/studio*',
                    status: 200,
                    headers: { 'x-ready': '1' },
                },
                set: { resourceId: '{{scottyResourceId}}' },
                repeat: 1,
            },
        ],
    },
};
const runner = new MacroRunner(path.join(root, 'errors'), undefined, onPause, session);

const macro = {
    name: 'cap-trigger-same-response-test',
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

// 再等 1s,确认不会自触发递归(重发数应保持 == repeat=1)
await new Promise((r) => setTimeout(r, 1000));
server.close();

const original = createHits.filter((r) => !r.resent);
const resent = createHits.filter((r) => r.resent);

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('/createvideo 总数 =', createHits.length, '| 原始 =', original.length, '| 重发 =', resent.length);
if (resent[0]) console.log('重发 body =', JSON.stringify(resent[0].body));

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
assert(original.length === 1, `/createvideo 恰有 1 原始(实际 ${original.length})`);
assert(resent.length === 1, `/createvideo 恰有 1 重发(实际 ${resent.length})`);
// 回归锚点:同一响应下,捕获必须先于触发写入变量池,重发才能拿到真实 scottyResourceId(而非空值/占位符)
assert(
    resent[0] && resent[0].body && resent[0].body.resourceId === REAL_SCOTTY,
    `重发 body.resourceId == "${REAL_SCOTTY}"(同一响应下捕获先于触发,注入真实值而非空)`
);
assert(
    resent[0] && resent[0].body && resent[0].body.resourceId !== 'PLACEHOLDER' && resent[0].body.resourceId !== '',
    '重发 body.resourceId 既非占位符也非空(证明 captures 变量确已就绪)'
);
// captures 命中并写变量池的日志应出现
const capLine = logLines.find((l) => /变量池更新/.test(l) && l.includes('scottyResourceId'));
assert(!!capLine, 'captures 命中并打出「变量池更新 {scottyResourceId}」日志');
// 修复后不应再出现「将注入空值」告警(旧实现顺序输赢时必现)
const emptyWarn = logLines.find((l) => /尚未捕获到/.test(l) && /将注入空值/.test(l));
assert(!emptyWarn, '不出现「scottyResourceId 尚未捕获到 … 将注入空值」告警(顺序已修复)');

if (failed > 0) {
    console.log(`\n❌ captures/responseTrigger 同响应时序回归未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log(
    '\n✅ captures 与 responseTrigger 命中同一响应时:捕获先于触发写入变量池,重发正确注入真实变量、无空值告警。'
);
process.exit(0);
