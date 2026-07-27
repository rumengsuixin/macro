// record.saveBodies「精确索引」离线自检:断言 RecordBodyIndex 的 JSONL 写入 / request+response 两 kind /
// 同 requestId 串联 / 懒建目录 / 落盘失败熔断。需先 `npm run build`(编译出 dist/core/record-body-index.js);
// 不需网络、不启 Electron。用法:node scripts/verify-record-body-index.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { RecordBodyIndex } = require('../dist/core/record-body-index.js');

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed += 1;
    }
}

function readLines(file) {
    if (!fs.existsSync(file)) {
        return [];
    }
    return fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-recidx-'));

console.log('1) 写 request+response,同 requestId 可 join,字段齐备');
{
    const idx = new RecordBodyIndex(path.join(tmpRoot, 'a'));
    idx.writeRequest({
        requestId: 'interception_job_91_0',
        method: 'POST',
        url: 'https://x.com/video/delete',
        file: 'rec-1-interception_job_91_0-req.json',
    });
    idx.writeResponse({
        requestId: 'interception_job_91_0',
        method: 'POST',
        url: 'https://x.com/video/delete',
        file: 'rec-2-interception_job_91_0-res.json',
        status: 200,
        mimeType: 'application/json',
        timingMs: 61,
    });
    const lines = readLines(idx.file);
    assert(lines.length === 2, '共写 2 行');
    const req = lines.find((l) => l.kind === 'request');
    const resp = lines.find((l) => l.kind === 'response');
    assert(!!req && !!resp, 'request / response 两种 kind 各一');
    assert(
        req.requestId === resp.requestId && req.requestId === 'interception_job_91_0',
        '同 requestId 可 join(串联 req/res)'
    );
    assert(typeof req.t === 'string' && typeof resp.t === 'string', 't 为 ISO 时间戳字符串');
    assert(
        req.method === 'POST' && req.url === 'https://x.com/video/delete',
        'request 行 method/url 正确'
    );
    assert(req.file === 'rec-1-interception_job_91_0-req.json', 'request 行 file = 请求体文件名');
    assert(
        resp.file === 'rec-2-interception_job_91_0-res.json' &&
            resp.status === 200 &&
            resp.mimeType === 'application/json' &&
            resp.timingMs === 61,
        'response 行 file/status/mimeType/timingMs 正确'
    );
    assert(idx.count === 2, 'count = 2');
    assert(path.basename(idx.file).startsWith('rec-index-') && idx.file.endsWith('.jsonl'), '索引文件名 rec-index-<戳>.jsonl');
}

console.log('2) 三个相同 URL 请求 → 靠不同 requestId 各自区分(精确关联的核心)');
{
    const idx = new RecordBodyIndex(path.join(tmpRoot, 'b'));
    for (const id of ['91', '92', '93']) {
        idx.writeRequest({ requestId: id, method: 'POST', url: 'https://x/same', file: `rec-${id}-req.json` });
        idx.writeResponse({ requestId: id, method: 'POST', url: 'https://x/same', file: `rec-${id}-res.json`, status: 200 });
    }
    const lines = readLines(idx.file);
    assert(lines.length === 6, '3 请求 × (req+res) = 6 行');
    for (const id of ['91', '92', '93']) {
        const pair = lines.filter((l) => l.requestId === id);
        assert(
            pair.length === 2 &&
                pair.find((l) => l.kind === 'request')?.file === `rec-${id}-req.json` &&
                pair.find((l) => l.kind === 'response')?.file === `rec-${id}-res.json`,
            `requestId=${id} 恰好一对 req/res、文件名各自对应(URL 相同也不混淆)`
        );
    }
}

console.log('3) 追加语义 —— N 次写 = N 行');
{
    const idx = new RecordBodyIndex(path.join(tmpRoot, 'c'));
    for (let i = 0; i < 5; i += 1) {
        idx.writeRequest({ requestId: String(i), method: 'GET', url: `https://x/${i}`, file: `f${i}.bin` });
    }
    assert(readLines(idx.file).length === 5, '5 次写 → 5 行(append 语义)');
    assert(idx.count === 5, 'count = 5');
}

console.log('4) 懒建目录 —— 首写前目录不存在,首写后存在');
{
    const dir = path.join(tmpRoot, 'lazy', 'deep');
    const idx = new RecordBodyIndex(dir);
    assert(!fs.existsSync(dir), '构造后目录尚未创建');
    idx.writeRequest({ requestId: '1', method: 'GET', url: 'https://x/a', file: 'a.bin' });
    assert(fs.existsSync(dir), '首写后目录已建');
}

console.log('5) 熔断 —— 落盘失败后不抛、count 停增');
{
    const blocker = path.join(tmpRoot, 'blocker.txt');
    fs.writeFileSync(blocker, 'x');
    const idx = new RecordBodyIndex(path.join(blocker, 'sub')); // 父级是文件 → mkdir 必失败
    let threw = false;
    try {
        idx.writeRequest({ requestId: '1', method: 'GET', url: 'https://x/a', file: 'a.bin' });
        idx.writeResponse({ requestId: '1', method: 'GET', url: 'https://x/a', file: 'a.bin', status: 200 });
    } catch {
        threw = true;
    }
    assert(!threw, '落盘失败不抛出(不拖垮主流程)');
    assert(idx.count === 0, 'count 保持 0(熔断后不再写)');
}

try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
    /* 忽略清理异常 */
}

if (failed > 0) {
    console.error(`\n自检失败:${failed} 项未通过。`);
    process.exit(1);
}
console.log('\n全部通过 ✅');
