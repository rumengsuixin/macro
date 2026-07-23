// 离线自检:验证「事件钩子」(块七)。本机 http 收 webhook,不出公网。
// 覆盖:
//   A. 加载器:首次写 inert 模板(enabled:false + 四事件示例)、坏 JSON 回退全关、normalize 剔非法动作、setHooksEnabled。
//   B. webhook:on-complete 派发 → 本机 server 收到、method 正确、bodyTemplate 变量渲染 + JSON 转义(含引号安全)。
//   C. enabled:false → 零对外(server 收不到)。
//   D. on-failure:error.* 变量齐全注入 body。
//   E. status-file:写在 dataRoot 内 OK;目录穿越被拒(不落盘)。
//   F. notify:注入的桌面通知回调被调用、标题渲染正确。
// 用法:npm run build && node scripts/verify-hooks.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { loadHooksConfig, setHooksEnabled } = require('../dist/core/hooks-config.js');
const { dispatchHooks } = require('../dist/core/hooks-dispatcher.js');

const tmpRoot = path.join(os.tmpdir(), `macro-hooks-verify-${process.pid}`);
mkdirSync(tmpRoot, { recursive: true });

let failed = false;
function check(cond, label) {
    console.log(`${cond ? '✅' : '❌'} ${label}`);
    if (!cond) failed = true;
}

// 本机 webhook 接收服务器:记录每个请求的 method + body
const received = [];
const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
        body += c;
    });
    req.on('end', () => {
        received.push({ method: req.method, url: req.url, body });
        res.statusCode = 200;
        res.end('ok');
    });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const hookUrl = `http://127.0.0.1:${port}/hook`;

// ========== A. 加载器 ==========
const cfgPath = path.join(tmpRoot, 'hooks.json');
const tpl = loadHooksConfig(cfgPath);
check(existsSync(cfgPath), '首次加载写出 hooks.json 模板');
check(tpl.enabled === false, '模板默认 enabled:false(inert)');
check(!!tpl.events['on-start'] && !!tpl.events['on-complete'] && !!tpl.events['on-failure'], '模板含 on-start/complete/failure 示例');

const badPath = path.join(tmpRoot, 'bad.json');
writeFileSync(badPath, '{ not json', 'utf-8');
const bad = loadHooksConfig(badPath);
check(bad.enabled === false && Object.keys(bad.events).length === 0, '坏 JSON 回退全关');

// normalize 剔非法:webhook 缺 url / 未知 action 被剔,合法 notify 保留
const dirtyPath = path.join(tmpRoot, 'dirty.json');
writeFileSync(
    dirtyPath,
    JSON.stringify({
        enabled: true,
        events: {
            'on-complete': [
                { action: 'webhook' }, // 缺 url → 剔
                { action: 'teleport' }, // 未知 → 剔
                { action: 'notify', title: 'ok' }, // 合法 → 留
            ],
        },
    }),
    'utf-8'
);
const dirty = loadHooksConfig(dirtyPath);
check(dirty.events['on-complete'].length === 1 && dirty.events['on-complete'][0].action === 'notify', 'normalize 剔非法动作、保留合法');

check(setHooksEnabled(cfgPath, true).enabled === true, 'setHooksEnabled 开');
check(loadHooksConfig(cfgPath).enabled === true, '开关已持久化');
check(setHooksEnabled(cfgPath, false).enabled === false, 'setHooksEnabled 关');

// ========== B. webhook 派发(含 JSON 转义) ==========
const webhookCfg = {
    enabled: true,
    events: {
        'on-complete': [
            {
                action: 'webhook',
                url: hookUrl,
                method: 'POST',
                bodyTemplate: '{"macro":"{{macroName}}","rows":{{rowCount}}}',
            },
        ],
    },
};
received.length = 0;
await dispatchHooks(webhookCfg, 'on-complete', { macroName: 'a"b\n宏', status: 'success', rowCount: 42 }, { dataRoot: tmpRoot });
check(received.length === 1 && received[0].method === 'POST', 'on-complete 触发 1 次 POST');
let parsed = null;
try {
    parsed = JSON.parse(received[0].body);
} catch {
    /* 解析失败下方断言会红 */
}
check(!!parsed && parsed.macro === 'a"b\n宏', 'body 变量渲染 + JSON 转义(引号/换行安全)');
check(!!parsed && parsed.rows === 42, 'body 数字变量原样注入');

// ========== C. enabled:false 零对外 ==========
received.length = 0;
await dispatchHooks({ ...webhookCfg, enabled: false }, 'on-complete', { macroName: 'x', status: 'success', rowCount: 1 }, { dataRoot: tmpRoot });
check(received.length === 0, 'enabled:false 时零对外(server 未收到)');

// 事件无动作也零对外
received.length = 0;
await dispatchHooks(webhookCfg, 'on-start', { macroName: 'x', status: 'started' }, { dataRoot: tmpRoot });
check(received.length === 0, '该事件无动作时零对外');

// ========== D. on-failure error.* 注入 ==========
const failCfg = {
    enabled: true,
    events: {
        'on-failure': [
            {
                action: 'webhook',
                url: hookUrl,
                bodyTemplate: '{"msg":"{{error.message}}","step":"{{error.stepType}}","at":"{{error.url}}"}',
            },
        ],
    },
};
received.length = 0;
await dispatchHooks(
    failCfg,
    'on-failure',
    { macroName: 'x', status: 'failure', error: { stepIndex: 3, stepType: 'click', url: 'https://z/p', message: '元素未找到' } },
    { dataRoot: tmpRoot }
);
const fbody = received.length === 1 ? JSON.parse(received[0].body) : {};
check(fbody.msg === '元素未找到' && fbody.step === 'click' && fbody.at === 'https://z/p', 'on-failure 注入 error.* 详情');

// ========== E. status-file 写入 + 穿越拒绝 ==========
const okFileCfg = {
    enabled: true,
    events: { 'on-complete': [{ action: 'status-file', path: '{{dataRoot}}/status/out.json', template: '{"s":"{{status}}","n":{{rowCount}}}' }] },
};
await dispatchHooks(okFileCfg, 'on-complete', { macroName: 'x', status: 'success', rowCount: 7 }, { dataRoot: tmpRoot });
const statusFile = path.join(tmpRoot, 'status', 'out.json');
check(existsSync(statusFile), 'status-file 写入 dataRoot 内');
const sContent = existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, 'utf-8')) : {};
check(sContent.s === 'success' && sContent.n === 7, 'status-file 内容模板渲染正确');

const escapeCfg = {
    enabled: true,
    events: { 'on-complete': [{ action: 'status-file', path: '{{dataRoot}}/../escaped-{{status}}.json', template: 'x' }] },
};
await dispatchHooks(escapeCfg, 'on-complete', { macroName: 'x', status: 'success' }, { dataRoot: tmpRoot });
check(!existsSync(path.join(tmpRoot, '..', 'escaped-success.json')), '目录穿越被拒(dataRoot 外不落盘)');

// ========== F. notify 注入 ==========
const notifies = [];
const notifyCfg = { enabled: true, events: { 'on-start': [{ action: 'notify', title: '开始 {{macroName}}', body: '{{status}}' }] } };
await dispatchHooks(notifyCfg, 'on-start', { macroName: 'DemoX', status: 'started' }, { notify: (t, b) => notifies.push({ t, b }), dataRoot: tmpRoot });
check(notifies.length === 1 && notifies[0].t === '开始 DemoX' && notifies[0].b === 'started', 'notify 回调被调用、标题/正文渲染正确');

server.close();
rmSync(tmpRoot, { recursive: true, force: true });
console.log(failed ? '\n❌ 有用例未通过' : '\n✅ 事件钩子自检全部通过');
process.exit(failed ? 1 : 0);
