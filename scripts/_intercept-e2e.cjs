// 录制端请求改写「真跑 Electron」端到端自检的主进程脚本(被 verify-request-intercept.mjs 拉起)。
// 流程:起本地 echo 服务(同源提供测试页,避免 CORS)→ 建带 <webview> 的窗口(show:false)
//      → did-attach-webview 挂真实 RequestInterceptor(规则改写 POST body)
//      → 测试页 fetch POST /echo → 断言服务端收到的是「改写后」的 body。
// 真正跑通 CDP 的 Fetch.enable / getRequestPostData / continueRequest(base64)链路。
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
const hardTimer = setTimeout(() => fail('超时(15s):可能是 Fetch 拦截未生效或 webview 未发起请求'), 15000);

let receivedBody = null;

const PAGE_HTML = `<!doctype html><meta charset="utf-8"><body>
<script>
  // 等一会儿确保拦截器已 Fetch.enable,再发起同源 POST
  setTimeout(function () {
    fetch('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: 1, size: 20, debug: true })
    }).catch(function () {});
  }, 1200);
</script>
</body>`;

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/echo')) {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            receivedBody = Buffer.concat(chunks).toString('utf8');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
            check();
        });
        return;
    }
    // 其它路径(/、favicon 等)返回测试页
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
});

function check() {
    clearTimeout(hardTimer);
    console.log(`服务端收到的请求体:${receivedBody}`);
    let obj;
    try {
        obj = JSON.parse(receivedBody);
    } catch (e) {
        return fail(`收到的 body 不是合法 JSON:${e.message}`);
    }
    const ok =
        obj.size === 100 && obj.injected === 'yes' && obj.page === 1 && !('debug' in obj);
    if (!ok) {
        return fail(
            `body 未按规则改写。期望 size=100 / injected=yes / 保留 page=1 / 删除 debug,实际:${receivedBody}`
        );
    }
    console.log('  ✅ set 覆盖 size=100');
    console.log('  ✅ set 新增 injected=yes');
    console.log('  ✅ 保留未涉及字段 page=1');
    console.log('  ✅ remove 删除 debug');
    pass('CDP Fetch 改写 POST body 链路正常。');
}

app.whenReady().then(() => {
    const port = 0;
    server.listen(port, '127.0.0.1', () => {
        const actualPort = server.address().port;
        const pageUrl = `http://127.0.0.1:${actualPort}/`;

        // 临时规则文件:enabled + 一条改写 /echo 的规则
        const rulesPath = path.join(os.tmpdir(), `macro-e2e-rules-${process.pid}.json`);
        fs.writeFileSync(
            rulesPath,
            JSON.stringify(
                {
                    enabled: true,
                    rules: [
                        {
                            urlPattern: '*/echo*',
                            bodyType: 'json',
                            set: { size: 100, injected: 'yes' },
                            remove: ['debug'],
                        },
                    ],
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

        // 挂载真实拦截器到 webview guest
        win.webContents.on('did-attach-webview', (_e, guest) => {
            const interceptor = new RequestInterceptor(rulesPath);
            interceptor.attach(guest);
        });

        // 宿主页内嵌一个 <webview> 指向 echo 服务(同源,避免 CORS 预检)
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
