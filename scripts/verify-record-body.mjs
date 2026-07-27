// 回放端「record 支路:请求/响应体独立落盘(saveBodies)」端到端自检。
// 验证:命中 URL 的**完整请求体**与**完整响应体**各被逐字节保真写成独立文件,且 req/res 文件按同一
// CDP requestId 天然配对;后缀既能按 content-type 推断、也能被显式 requestExt/responseExt 覆盖。
//
// 关键点:
//  - 请求体走 Blob 上传(模拟 File,旧 postDataBuffer 抓不到)→ CDP 请求阶段 postDataEntries 重组。
//  - 响应体走 CDP 响应阶段 Fetch.getResponseBody(含二进制/解压后);响应用 application/octet-stream
//    保证 base64Encoded=true、二进制逐字节保真(声称文本类型会让 CDP 按文本解码而损坏无效 UTF-8 字节)。
//  - session enabled:false 但 record.enabled:true —— 证 body 落盘随 record 走、**独立于改写总闸 enabled**。
//  - MacroRunner 第 7 参传临时 dumpsDir(record body 与 dump 共用该目录)。
//
// 用法:MACRO_HEADLESS=1 node scripts/verify-record-body.mjs
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

// 请求体:256 种字节值各 3 次(768 字节,含 0x00/0xFF 及大量无效 UTF-8);响应体:另一模式(512 字节),
// 两者不同以便断言 req 文件==请求体、res 文件==响应体,互不混淆。
const reqBytes = Array.from({ length: 768 }, (_, i) => i % 256);
const resBytes = Array.from({ length: 512 }, (_, i) => (i * 7 + 13) % 256);
const reqExpected = Buffer.from(reqBytes);
const resExpected = Buffer.from(resBytes);

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>record-body</title>
<div id="host">初始化…</div>
<script>
(async function(){
  var arr = new Uint8Array(${JSON.stringify(reqBytes)});
  var body = new Blob([arr], {type:'video/mp4'}); // 模拟 File 上传
  try {
    var resp = await fetch('/api/echo', { method:'POST', headers:{'Content-Type':'video/mp4'}, body: body });
    await resp.arrayBuffer(); // 读完响应体,确保浏览器完整接收(触发 CDP 响应阶段落盘后放行)
    var d = document.createElement('div'); d.id='done'; d.textContent='往返已完成'; document.body.appendChild(d);
  } catch (e) {
    var f = document.createElement('div'); f.id='failed'; f.textContent=String(e); document.body.appendChild(f);
  }
})();
</script>`);
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/echo')) {
        req.on('data', () => {});
        req.on('end', () => {
            // 响应用 application/octet-stream:CDP getResponseBody 以 base64 返回,二进制逐字节保真
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            res.end(Buffer.from(resBytes));
        });
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`本地 echo 服务已启动:http://127.0.0.1:${port}/`);

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed += 1;
    }
}

// 解析落盘文件名 rec-<ts>-<id>-<kind>.<ext>(id 已消毒为仅字母数字下划线,故 '-' 分段稳定)
function parseRec(name) {
    const m = name.match(/^rec-(\d+)-([A-Za-z0-9_]+)-(req|res)\.([A-Za-z0-9]+)$/);
    return m ? { ts: m[1], id: m[2], kind: m[3], ext: m[4] } : null;
}

// 跑一种配置:label 仅用于目录名;saveBodiesExtra 合入 saveBodies 规则(测显式后缀覆盖);
// expectReqExt/expectResExt 为期望后缀。断言:回放成功 + req/res 各 1 文件且逐字节保真 + 后缀符合 + requestId 配对。
async function runCase(label, saveBodiesExtra, expectReqExt, expectResExt) {
    const dumpsDir = fs.mkdtempSync(path.join(os.tmpdir(), `macro-recbody-${label}-`));
    const timelinesDir = fs.mkdtempSync(path.join(os.tmpdir(), `macro-recbody-tl-${label}-`));
    fs.mkdirSync(path.join(root, 'errors'), { recursive: true });
    const sessionOptions = {
        requestRules: {
            enabled: false, // 改写总闸关:证 body 落盘随 record.enabled 走、独立于 enabled
            rules: [],
            record: {
                enabled: true,
                urlPattern: '*',
                saveBodies: [
                    { urlPattern: '*/api/echo*', request: true, response: true, ...saveBodiesExtra },
                ],
            },
        },
    };
    const runner = new MacroRunner(
        path.join(root, 'errors'),
        undefined,
        undefined,
        sessionOptions,
        undefined,
        timelinesDir, // 第 6 参:record 时间线目录(验证与 body 索引精确 join)
        dumpsDir // 第 7 参:落盘目录(record body 与 dump 共用)
    );
    const macro = {
        name: `record-body-${label}`,
        version: 1,
        steps: [
            { type: 'goto', url: `http://127.0.0.1:${port}/` },
            { type: 'waitForSelector', selector: '#done', timeout: 15000 },
        ],
    };
    let result;
    try {
        result = await Promise.race([
            runner.run(macro),
            new Promise((_, reject) => setTimeout(() => reject(new Error('自检硬超时(30s)')), 30000)),
        ]);
    } catch (err) {
        console.error(`\n[${label}] ❌ 回放异常:`, err.message);
        failed += 1;
        return;
    }
    await new Promise((r) => setTimeout(r, 200)); // 落盘在放行前同步写完,给点余量

    const recs = fs
        .readdirSync(dumpsDir)
        .filter((f) => f.startsWith('rec-'))
        .map((f) => ({ name: f, ...(parseRec(f) || {}) }));
    const reqFiles = recs.filter((r) => r.kind === 'req');
    const resFiles = recs.filter((r) => r.kind === 'res');
    console.log(`\n[${label}] result.ok=${result && result.ok},落盘文件:`, recs.map((r) => r.name));

    assert(result && result.ok === true, `[${label}] 回放成功`);
    assert(reqFiles.length === 1, `[${label}] 恰好落盘 1 个请求体文件(实际 ${reqFiles.length})`);
    assert(resFiles.length === 1, `[${label}] 恰好落盘 1 个响应体文件(实际 ${resFiles.length})`);

    if (reqFiles.length === 1) {
        const buf = fs.readFileSync(path.join(dumpsDir, reqFiles[0].name));
        assert(Buffer.compare(buf, reqExpected) === 0, `[${label}] 请求体逐字节保真(${buf.length} 字节)`);
        assert(reqFiles[0].ext === expectReqExt, `[${label}] 请求体后缀=${expectReqExt}(实际 ${reqFiles[0].ext})`);
    }
    if (resFiles.length === 1) {
        const buf = fs.readFileSync(path.join(dumpsDir, resFiles[0].name));
        assert(Buffer.compare(buf, resExpected) === 0, `[${label}] 响应体逐字节保真(${buf.length} 字节)`);
        assert(resFiles[0].ext === expectResExt, `[${label}] 响应体后缀=${expectResExt}(实际 ${resFiles[0].ext})`);
    }
    if (reqFiles.length === 1 && resFiles.length === 1) {
        assert(
            reqFiles[0].id && reqFiles[0].id === resFiles[0].id,
            `[${label}] 请求体/响应体文件按同一 requestId 配对(id=${reqFiles[0].id})`
        );
    }

    // 精确索引:dumps/rec-index-<戳>.jsonl —— 每个 body 文件一行,同 requestId 串联 req/res
    const idxFiles = fs
        .readdirSync(dumpsDir)
        .filter((f) => f.startsWith('rec-index-') && f.endsWith('.jsonl'));
    assert(idxFiles.length === 1, `[${label}] 恰好生成 1 个精确索引文件(实际 ${idxFiles.length})`);
    if (idxFiles.length === 1 && reqFiles.length === 1 && resFiles.length === 1) {
        const idx = fs
            .readFileSync(path.join(dumpsDir, idxFiles[0]), 'utf-8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l));
        const idxReq = idx.find((e) => e.kind === 'request');
        const idxRes = idx.find((e) => e.kind === 'response');
        assert(!!idxReq && !!idxRes, `[${label}] 索引含 request + response 各一行`);
        assert(idxReq && idxReq.file === reqFiles[0].name, `[${label}] 索引 request 行 file = 实际请求体文件名`);
        assert(idxRes && idxRes.file === resFiles[0].name, `[${label}] 索引 response 行 file = 实际响应体文件名`);
        assert(
            idxReq && idxRes && idxReq.requestId === idxRes.requestId,
            `[${label}] 索引 req/res 同 requestId 精确串联(id=${idxReq && idxReq.requestId})`
        );
        assert(
            idxRes && idxRes.status === 200 && idxRes.url.endsWith('/api/echo') && idxRes.method === 'POST',
            `[${label}] 索引 response 行 status/url/method 正确`
        );
        // 精确 join:rec-index 的 networkId 应能在 record 时间线(CDP Network,与 saveBodies 同 session)找到 id 相等的记录
        const tlFiles = fs
            .readdirSync(timelinesDir)
            .filter((f) => f.startsWith('timeline-replay-') && f.endsWith('.jsonl'));
        const tl = tlFiles.flatMap((f) =>
            fs
                .readFileSync(path.join(timelinesDir, f), 'utf-8')
                .split('\n')
                .filter((l) => l.trim())
                .map((l) => JSON.parse(l))
        );
        assert(tl.length > 0, `[${label}] 生成 record 时间线(CDP Network)`);
        assert(!!(idxReq && idxReq.networkId), `[${label}] rec-index 行带 networkId(join 键)`);
        if (idxReq && idxReq.networkId) {
            const joined = tl.find((e) => e.id === idxReq.networkId);
            assert(
                !!joined,
                `[${label}] rec-index.networkId 精确 join 到时间线记录(networkId=${idxReq.networkId})`
            );
            assert(
                !!(joined && /\/api\/echo/.test(joined.url)),
                `[${label}] join 到的时间线记录 url 命中 /api/echo`
            );
        }
    }

    try {
        fs.rmSync(dumpsDir, { recursive: true, force: true });
        fs.rmSync(timelinesDir, { recursive: true, force: true });
    } catch {
        /* 忽略 */
    }
}

console.log('\n========== 验证结果 ==========');
// infer:不配后缀,验证 content-type 推断(请求 video/mp4→mp4,响应 octet-stream→bin)+ 二进制保真 + 配对
await runCase('infer', {}, 'mp4', 'bin');
// explicit:显式 requestExt/responseExt 覆盖,验证后缀优先级
await runCase('explicit', { requestExt: 'reqx', responseExt: '.resx' }, 'reqx', 'resx');

// 反证:string(UTF-8)路径会损坏这些字节——证明落盘必须走原始字节
const naive = Buffer.from(reqExpected.toString('utf-8'), 'utf-8');
assert(Buffer.compare(naive, reqExpected) !== 0, 'string(UTF-8)路径会损坏这些字节(故落盘必须走原始字节)');

server.close();

if (failed > 0) {
    console.log(`\n❌ record 请求/响应体落盘未达预期:${failed} 项未通过。`);
    process.exit(1);
}
console.log(
    '\n✅ record 请求/响应体落盘端到端通过:CDP 请求阶段抓 Blob 上传体、响应阶段 getResponseBody 抓响应体,' +
        '各逐字节保真写成独立文件,按 requestId 配对,后缀推断/显式覆盖均正确;且独立于改写总闸 enabled。'
);
process.exit(0);
