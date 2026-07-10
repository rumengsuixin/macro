// 请求时间线记录器离线自检:断言 TimelineRecorder 的 JSONL 写入 / urlPattern 匹配 /
// body 完整性(禁止截断)/ 追加语义 / 懒建目录 / 落盘失败熔断。
// 需先 `npm run build`(编译出 dist/core/timeline-recorder.js);不需网络、不启 Electron。
// 用法:node scripts/verify-timeline-recorder.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { TimelineRecorder } = require('../dist/core/timeline-recorder.js');

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed += 1;
    }
}

/** 读回时间线文件的所有 JSON 行 */
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-timeline-'));

console.log('1) 写请求+响应两行,同 id 可 join,字段齐备');
{
    const dir = path.join(tmpRoot, 'a');
    const rec = new TimelineRecorder(dir, 'replay', '*');
    rec.writeRequest({ id: '1', method: 'POST', url: 'https://x.com/api', reqHeaders: { 'x-a': '1' }, reqBody: '{"k":1}' });
    rec.writeResponse({ id: '1', method: 'POST', url: 'https://x.com/api', status: 200, timingMs: 42, mimeType: 'application/json' });
    const lines = readLines(rec.file);
    assert(lines.length === 2, '共写 2 行');
    const req = lines.find((l) => l.kind === 'request');
    const resp = lines.find((l) => l.kind === 'response');
    assert(!!req && !!resp, 'request / response 两种 kind 各一');
    assert(req.id === resp.id && req.id === '1', '同 id 可 join');
    assert(req.phase === 'replay' && resp.phase === 'replay', 'phase 由构造注入');
    assert(typeof req.t === 'string' && typeof resp.t === 'string', 't 为 ISO 时间戳字符串');
    assert(req.method === 'POST' && req.url === 'https://x.com/api', 'request 的 method/url 正确');
    assert(req.reqHeaders && req.reqHeaders['x-a'] === '1' && req.reqBody === '{"k":1}', 'request 带 headers/body');
    assert(resp.status === 200 && resp.timingMs === 42 && resp.mimeType === 'application/json', 'response 带 status/timingMs/mimeType');
    assert(rec.count === 2, 'count = 2');
}

console.log('2) matches —— urlPattern 命中/不命中');
{
    const rec = new TimelineRecorder(path.join(tmpRoot, 'b'), 'record', '*/echo*');
    assert(rec.matches('https://x.com/echo?a=1') === true, 'urlPattern 命中');
    assert(rec.matches('https://x.com/other') === false, 'urlPattern 不命中');
    const recAll = new TimelineRecorder(path.join(tmpRoot, 'b2'), 'record');
    assert(recAll.matches('https://anything/x') === true, '缺省 pattern → 恒匹配(记录所有)');
    const recStar = new TimelineRecorder(path.join(tmpRoot, 'b3'), 'record', '*');
    assert(recStar.matches('https://anything/y') === true, "'*' → 恒匹配");
    recStar.setPattern('*/only*');
    assert(recStar.matches('https://x/only') === true && recStar.matches('https://x/nope') === false, 'setPattern 热更新生效');
}

console.log('3) body 完整性 —— ~1MB reqBody 读回逐字相等(护禁止截断铁律)');
{
    const rec = new TimelineRecorder(path.join(tmpRoot, 'c'), 'record', '*');
    const big = 'x'.repeat(1024 * 1024) + '中文尾'; // >1MB + 多字节
    rec.writeRequest({ id: '1', method: 'POST', url: 'https://x/big', reqBody: big });
    const [line] = readLines(rec.file);
    assert(line.reqBody.length === big.length, `reqBody 长度一致(${line.reqBody.length})`);
    assert(line.reqBody === big, 'reqBody 内容逐字相等,未截断');
}

console.log('4) includeBody 语义交给调用方 —— 不传 reqBody 则该字段省略');
{
    const rec = new TimelineRecorder(path.join(tmpRoot, 'd'), 'record', '*');
    rec.writeRequest({ id: '1', method: 'GET', url: 'https://x/g' });
    const [line] = readLines(rec.file);
    assert(!('reqBody' in line) || line.reqBody === undefined, '未传 body → reqBody 省略');
}

console.log('5) 追加语义 —— N 次写 = N 行');
{
    const rec = new TimelineRecorder(path.join(tmpRoot, 'e'), 'replay', '*');
    for (let i = 0; i < 5; i += 1) {
        rec.writeRequest({ id: String(i), method: 'GET', url: `https://x/${i}` });
    }
    assert(readLines(rec.file).length === 5, '5 次写 → 5 行(append 语义)');
    assert(rec.count === 5, 'count = 5');
}

console.log('6) 懒建目录 —— 首写前目录不存在,首写后存在');
{
    const dir = path.join(tmpRoot, 'lazy', 'deep');
    const rec = new TimelineRecorder(dir, 'record', '*');
    assert(!fs.existsSync(dir), '构造后目录尚未创建');
    rec.writeRequest({ id: '1', method: 'GET', url: 'https://x/a' });
    assert(fs.existsSync(dir), '首写后目录已建');
}

console.log('7) 熔断 —— 落盘失败后置 disabled、后续不抛、count 停增');
{
    // 用一个「文件」当作目录父级 → mkdirSync recursive 必失败,触发熔断
    const blocker = path.join(tmpRoot, 'blocker.txt');
    fs.writeFileSync(blocker, 'x');
    const rec = new TimelineRecorder(path.join(blocker, 'sub'), 'record', '*');
    let threw = false;
    try {
        rec.writeRequest({ id: '1', method: 'GET', url: 'https://x/a' });
        rec.writeRequest({ id: '2', method: 'GET', url: 'https://x/b' });
    } catch {
        threw = true;
    }
    assert(!threw, '落盘失败不抛出(不拖垮主流程)');
    assert(rec.count === 0, 'count 保持 0(熔断后不再写)');
}

// 清理临时目录
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
