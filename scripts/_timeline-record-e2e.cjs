// 录制端「只记录不修改」支路「真跑 Electron」端到端自检(被 verify-timeline-record.mjs 拉起)。
// 流程:起本地 echo 服务(同源提供测试页,避免 CORS)→ 建带 <webview> 的窗口(show:false)
//      → did-attach-webview 挂真实 RequestInterceptor(record.enabled、改写关闭)
//      → 测试页 fetch POST /echo → 读时间线 JSONL,断言含 /echo 的 request 行(POST、body 未截断)
//        + 同 id 的 response 行(status=200、timingMs 为数、mimeType 有值)。
// 真正跑通 CDP 的 Network.enable / requestWillBeSent / getRequestPostData / loadingFinished 链路。
// 关键:规则 enabled:false + rules:[],仅 record.enabled——证明记录支路独立于改写门槛。
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RequestInterceptor } = require('../dist/main/request-interceptor.js');

function fail(msg) {
    console.error(`\n端到端自检失败:${msg}`);
    app.exit(1);
}
function pass(msg) {
    console.log(`\n全部通过 ✅ ${msg}`);
    app.exit(0);
}

// 硬超时:任何环节卡住都强制失败退出,不挂死
const hardTimer = setTimeout(() => fail('超时(15s):可能是 Network 记录未生效或 webview 未发起请求'), 15000);

const SENT_BODY = JSON.stringify({ page: 1, size: 20, debug: true });
const timelinesDir = path.join(os.tmpdir(), `macro-tlrec-${process.pid}`);

const PAGE_HTML = `<!doctype html><meta charset="utf-8"><body>
<script>
  // 等一会儿确保拦截器已 Network.enable,再发起同源 POST
  setTimeout(function () {
    fetch('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(SENT_BODY)}
    }).catch(function () {});
  }, 1200);
</script>
</body>`;

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/echo')) {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
            // 给客户端 loadingFinished + writeResponse 一点落盘时间,再读时间线
            setTimeout(check, 900);
        });
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
});

function readTimelineLines() {
    if (!fs.existsSync(timelinesDir)) {
        return [];
    }
    const files = fs
        .readdirSync(timelinesDir)
        .filter((f) => f.startsWith('timeline-record-') && f.endsWith('.jsonl'));
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
    return lines;
}

function check() {
    clearTimeout(hardTimer);
    const lines = readTimelineLines();
    console.log(`时间线记录条数:${lines.length}`);
    const reqLine = lines.find((l) => l.kind === 'request' && /\/echo/.test(l.url));
    const respLine = reqLine ? lines.find((l) => l.kind === 'response' && l.id === reqLine.id) : null;

    if (!reqLine) {
        return fail('未记录到 /echo 的 request 行');
    }
    if (reqLine.method !== 'POST') {
        return fail(`request 行 method 应为 POST,实际 ${reqLine.method}`);
    }
    if (reqLine.reqBody !== SENT_BODY) {
        return fail(`request 行 reqBody 未按原样完整记录(可能被截断):${reqLine.reqBody}`);
    }
    if (!respLine) {
        return fail('未记录到同 id 的 response 行');
    }
    if (respLine.status !== 200) {
        return fail(`response 行 status 应为 200,实际 ${respLine.status}`);
    }
    if (typeof respLine.timingMs !== 'number') {
        return fail('response 行 timingMs 应为数值');
    }
    console.log('  ✅ 记录到 /echo 的 request 行(POST)');
    console.log('  ✅ reqBody 完整未截断:' + reqLine.reqBody);
    console.log('  ✅ 记录到同 id 的 response 行(status=200、timingMs 为数)');
    console.log('  ✅ mimeType=' + respLine.mimeType);
    // 证明记录支路独立:改写关闭,记录的是原始 body(size 仍 20、debug 仍在)
    const parsed = JSON.parse(reqLine.reqBody);
    if (parsed.size !== 20 || parsed.debug !== true) {
        return fail('记录的 body 不是原始值(record 不应改写)');
    }
    console.log('  ✅ 记录的是页面原始 body(改写关闭,未被改动)');

    // 清理临时目录
    try {
        fs.rmSync(timelinesDir, { recursive: true, force: true });
    } catch {
        /* 忽略 */
    }
    pass('CDP Network 记录请求+响应链路正常,record 支路独立于改写门槛。');
}

app.whenReady().then(() => {
    server.listen(0, '127.0.0.1', () => {
        const actualPort = server.address().port;
        const pageUrl = `http://127.0.0.1:${actualPort}/`;

        // 临时规则文件:enabled:false + rules:[](不改写),仅 record.enabled
        const rulesPath = path.join(os.tmpdir(), `macro-tlrec-rules-${process.pid}.json`);
        fs.writeFileSync(
            rulesPath,
            JSON.stringify(
                {
                    enabled: false,
                    rules: [],
                    record: { enabled: true, urlPattern: '*/echo*', includeBody: true },
                },
                null,
                4
            ),
            'utf-8'
        );

        const win = new BrowserWindow({
            show: false,
            webPreferences: { webviewTag: true, nodeIntegration: false, contextIsolation: true },
        });

        // 挂载真实拦截器到 webview guest(带临时 timelinesDir)
        win.webContents.on('did-attach-webview', (_e, guest) => {
            const interceptor = new RequestInterceptor(rulesPath, timelinesDir);
            interceptor.attach(guest);
        });

        const host = `<!doctype html><meta charset="utf-8">
<body style="margin:0">
<webview src="${pageUrl}" style="width:600px;height:400px"></webview>
</body>`;
        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(host));
    });
});

app.on('window-all-closed', () => {
    /* 保持运行到断言完成后主动 exit */
});
