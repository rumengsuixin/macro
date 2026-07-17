// 回放端「请求体整体替换(拦截替换)」支路端到端自检:验证命中请求的整个 body 被本地文件的字节替换。
// 核心:页面发 **Blob** body(内容 A,模拟 File/文件上传);配 bodyReplaces 指向替换文件 B(内容/大小都不同);
// 断言服务端**实收字节 == B 逐字节相等**(替换生效、对 Blob 有效)、与 A 不等、且 content-length = B 字节数
//(证大小变化时长度正确重算)。旧的 rules 改写对 Blob 是 no-op,唯有 CDP continueRequest(postData) 能替换。
// 用法:MACRO_HEADLESS=1 node scripts/verify-body-replace.mjs
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

// A = 页面原始上传体(256 字节:0..255);B = 替换文件(600 字节:全字节值 + 大小不同,含无效 UTF-8)。
const bytesA = Array.from({ length: 256 }, (_, i) => i);
const bytesB = Array.from({ length: 600 }, (_, i) => (i * 7 + 3) % 256);
const bufA = Buffer.from(bytesA);
const bufB = Buffer.from(bytesB);

// 替换文件 B 落到临时文件
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-replace-'));
const replaceFile = path.join(tmpDir, 'replacement.bin');
fs.writeFileSync(replaceFile, bufB);

let recvBody = null; // 服务端实收 body(Buffer)
let recvLen = null; // 服务端实收 content-length 头
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>body-replace</title>
<div id="host">初始化…</div>
<script>
(async function(){
  var arr = new Uint8Array(${JSON.stringify(bytesA)});
  var blob = new Blob([arr], {type:'application/octet-stream'});  // Blob 上传体(rules 改写对它无效)
  try {
    await fetch('/upload', { method:'POST', body: blob });
    var d = document.createElement('div'); d.id='done'; d.textContent='ok'; document.body.appendChild(d);
  } catch (e) {
    var f = document.createElement('div'); f.id='failed'; f.textContent=String(e); document.body.appendChild(f);
  }
})();
</script>`);
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/upload')) {
        recvLen = req.headers['content-length'];
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            recvBody = Buffer.concat(chunks);
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
console.log(`本地服务已启动:http://127.0.0.1:${port}/  替换文件 B=${bufB.length} 字节`);

const sessionOptions = {
    requestRules: {
        enabled: true,
        rules: [],
        bodyReplaces: [{ urlPattern: '*/upload*', replaceWithFile: replaceFile }],
    },
};

const macro = {
    name: 'body-replace-test',
    version: 1,
    steps: [
        { type: 'goto', url: `http://127.0.0.1:${port}/` },
        { type: 'waitForSelector', selector: '#done', timeout: 15000 },
    ],
};

fs.mkdirSync(path.join(root, 'errors'), { recursive: true });
const runner = new MacroRunner(path.join(root, 'errors'), undefined, undefined, sessionOptions);

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
try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
    /* 忽略 */
}

console.log('\n========== 验证结果 ==========');
console.log('result.ok =', result && result.ok);
console.log('服务端实收字节数 =', recvBody ? recvBody.length : null, ' content-length 头 =', recvLen);

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed += 1;
    }
}

assert(result && result.ok === true, '回放成功');
assert(!!recvBody, '服务端收到了 body');
if (recvBody) {
    assert(
        Buffer.compare(recvBody, bufB) === 0,
        `服务端实收 == 替换文件 B **逐字节相等**(${recvBody.length}=${bufB.length},整体替换生效、对 Blob 有效)`
    );
    assert(
        Buffer.compare(recvBody, bufA) !== 0,
        '服务端实收 != 页面原始体 A(证明确实被替换了,不是原样发出)'
    );
    assert(
        recvLen === String(bufB.length),
        `content-length 头 = 替换文件字节数 ${bufB.length}(大小变化时长度正确重算,实际 ${recvLen})`
    );
}

if (failed > 0) {
    console.log(`\n❌ 回放端请求体替换未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log(
    '\n✅ 回放端请求体整体替换端到端通过:拦截命中请求 → 用本地文件字节整体替换 Blob 上传体 → 服务端实收替换内容、长度正确。'
);
process.exit(0);
