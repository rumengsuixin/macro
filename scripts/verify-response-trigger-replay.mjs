// 回放端「重发响应条件触发」端到端自检:验证「捕获某响应,满足 status/headers/bodyJson 条件才重发」。
//
// 设计(仿 verify-resend 骨架,但触发源改为**响应**、且同时验证条件门槛):
//  - 本地 echo 服务:GET / 返回测试页,加载即发**两个** POST /status:
//      · POST /status?case=done    → 响应 x-ready:1 + body {"data":{"state":"done"}}   (满足条件)
//      · POST /status?case=pending → 响应 x-ready:1 + body {"data":{"state":"pending"}}(bodyJson 不满足)
//  - POST /status 记录 { url, body, resent:!!x-macro-resend, ts }。
//  - session:enabled:true、rules:[]、resends:[{ urlPattern:'*/status*',
//      responseTrigger:{ status:200, headers:{'x-ready':'1'}, bodyJson:{'data.state':'done'} },
//      delayMs:800, repeat:1 }](无 targetUrl → 重发打回触发它的同一 /status URL)。
//  - 宏 = [goto, pause];onPause 轮询「≥2 原始 && ≥1 重发」才 resolve(让宏正常收尾 run.ok=true)。
// 断言:①恰 2 条原始(done+pending,均无标记头);②恰 1 条重发(有标记头);③重发的 url 含 case=done、
//       body.seq=done(证**只有满足条件的 done 响应触发了**、pending 被条件门槛挡掉);④延时≈800ms;
//       ⑤等足够久后重发数==1 不增长(证 isResendOrigin 阻断了「重发的响应又触发重发」的递归)。
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

/** 服务端收到的每个 /status:{ url, body(已解析), resent(是否带标记头), ts } */
const received = [];

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // 页面加载即发两个 POST /status:一个会满足条件(done)、一个不满足(pending)
        res.end(`<!doctype html><meta charset="utf-8"><title>resp-trigger</title>
<div id="host">running</div>
<script>
  function hit(c) {
    return fetch('/status?case=' + c, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq: c })
    }).catch(function () {});
  }
  hit('done');
  hit('pending');
</script>`);
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/status')) {
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
            received.push({
                url: req.url,
                body,
                resent: !!req.headers['x-macro-resend'],
                ts: Date.now(),
            });
            const state = req.url.includes('case=pending') ? 'pending' : 'done';
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'x-ready': '1',
            });
            res.end(JSON.stringify({ data: { state } }));
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

// onPause:保持回放存活,直到「≥2 原始 + ≥1 重发」才 resolve(让 pause 结束、宏正常收尾)
const onPause = () =>
    new Promise((resolve) => {
        const iv = setInterval(() => {
            const original = received.filter((r) => !r.resent);
            const resent = received.filter((r) => r.resent);
            if (original.length >= 2 && resent.length >= 1) {
                clearInterval(iv);
                resolve();
            }
        }, 100);
    });

fs.mkdirSync(path.join(root, 'errors'), { recursive: true });
const session = {
    requestRules: {
        enabled: true,
        rules: [], // 改写全关:证明响应触发重发独立于改写
        resends: [
            {
                urlPattern: '*/status*',
                responseTrigger: {
                    status: 200,
                    headers: { 'x-ready': '1' },
                    bodyJson: { 'data.state': 'done' },
                },
                delayMs: DELAY_MS,
                repeat: 1,
            },
        ],
    },
};
const runner = new MacroRunner(path.join(root, 'errors'), undefined, onPause, session);

const macro = {
    name: 'resp-trigger-test',
    version: 1,
    steps: [
        { type: 'goto', url: pageUrl },
        { type: 'pause' }, // onPause 轮询到「2 原始 + 1 重发」后放行,宏收尾
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

// 再等 2s,验证重发不会自触发递归(重发数应保持 == repeat=1)
await new Promise((r) => setTimeout(r, 2000));
server.close();

const original = received.filter((r) => !r.resent);
const resent = received.filter((r) => r.resent);
const doneOriginal = original.find((r) => r.url.includes('case=done'));

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('总请求 =', received.length, '| 原始 =', original.length, '| 重发 =', resent.length);
console.log('原始 urls =', original.map((r) => r.url).join(', '));
if (resent[0]) console.log('重发 url =', resent[0].url, '| body =', JSON.stringify(resent[0].body));
if (doneOriginal && resent[0]) {
    console.log('重发延时(ms) ≈', resent[0].ts - doneOriginal.ts, `(配置 ${DELAY_MS})`);
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
assert(original.length === 2, `恰有 2 条原始请求 done+pending(实际 ${original.length})`);
assert(resent.length === 1, `恰有 1 条重发请求(实际 ${resent.length})`);
assert(
    resent[0] && resent[0].url.includes('case=done'),
    '重发打到 case=done 的 URL(证只有满足条件的 done 响应触发了)'
);
assert(
    resent[0] && resent[0].body && resent[0].body.seq === 'done',
    '重发 body 基于 done 请求(seq=done),pending 未触发(条件门槛生效)'
);
assert(
    doneOriginal && resent[0] && resent[0].ts - doneOriginal.ts >= DELAY_MS - 300,
    `重发延时 ≥ ${DELAY_MS - 300}ms(证"满足条件后延时重发")`
);
assert(resent.length === 1, `重发数 == repeat(=1)不增长(证防递归:重发的响应不再触发,实际 ${resent.length})`);

if (failed > 0) {
    console.log(`\n❌ 响应触发重发未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log(
    '\n✅ 回放端「重发响应条件触发」通过:满足 status/headers/bodyJson(AND)才重发,条件门槛挡掉不满足项、防递归、独立于改写。'
);
process.exit(0);
