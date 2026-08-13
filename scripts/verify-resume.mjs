// list-detail「数据补全(增量重抓)」离线自检:直接驱动编译后的 extract() + resume-store,
// 用本机 http 服务起「列表页 + 三个详情页」,断言补抓快照的复用/落盘/作废语义。
//
// 装置关键:服务端给每个详情页记命中次数(hits)——这是「真的没重新导航」的唯一硬证据,
// 只断言行数会漏掉「其实还是抓了一遍」。详情页可控失败、Pin 值带代数(g1/g2)以区分新旧值。
//
// 覆盖:首跑部分失败→二跑只补失败项 / 1:N 行数由快照定 + 列表字段取新值 / default 陷阱 /
//       0 命中=empty / 签名精度(详情侧变更作废、列表侧变更不作废) / 损坏容忍 / 增量落盘 /
//       写模式(全量 truncate) / 不传第 5 参完全向后兼容。
// 需先 `npm run build`。用法:node scripts/verify-resume.mjs
//   本机缺 headless chromium 时前置:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extract } = require('../dist/core/extractor.js');
const { createResumeStore, resumeSignature } = require('../dist/core/resume-store.js');
const { chromium } = require('playwright');

if (typeof extract !== 'function' || typeof createResumeStore !== 'function') {
    console.error('未导出 extract / createResumeStore,请确认已 npm run build');
    process.exit(1);
}

// ===== 可变服务端状态:控制失败、行数、列表字段值、Pin 值代数 =====
const state = { failB: true, aRows: 3, status: '待发货', gen: 1 };

const listHtml = () => `<!doctype html><meta charset="utf-8"><body>
<table id="list"><tbody>
  <tr data-id="A"><td class="st">${state.status}</td><td><a class="d" href="/detail/a">订单A</a></td></tr>
  <tr data-id="B"><td class="st">${state.status}</td><td><a class="d" href="/detail/b">订单B</a></td></tr>
  <tr data-id="C"><td class="st">${state.status}</td><td><a class="d" href="/detail/c">订单C</a></td></tr>
</tbody></table></body>`;

/** 详情页:带 Pin 明细表(1:N 展开源) */
const pinPage = (tag, n) => `<!doctype html><meta charset="utf-8"><body>
<div id="pin_form"><table>
  <thead><tr><th>#</th><th>Pin</th></tr></thead>
  <tbody>
    ${Array.from({ length: n }, (_, i) => `<tr><td>${i + 1}.</td><td>${tag}-PIN-${i + 1}-g${state.gen}</td></tr>`).join('')}
  </tbody>
</table></div></body>`;

/**
 * 详情页:有 Pin 表但单元格为空 → 子列表命中、值全空 → 应判 empty。
 * 刻意让选择器命中:这样不必付 DETAIL_LIST_SETTLE_TIMEOUT(15s)的等待,自检才跑得快。
 */
const blankPinPage = `<!doctype html><meta charset="utf-8"><body>
<div id="pin_form"><table>
  <thead><tr><th>#</th><th>Pin</th></tr></thead>
  <tbody><tr><td></td><td></td></tr></tbody>
</table></div></body>`;

/** 详情页:完全没有 Pin 表(子列表 0 命中 → 等满 15s settle 后判 empty);只在专项用例里用一次 */
const noTablePage = `<!doctype html><meta charset="utf-8"><body><div id="nothing">该订单暂无明细</div></body>`;

/** 只含一个订单 E 的列表页:专测「0 命中」,避免每轮都付 15s */
const listEHtml = `<!doctype html><meta charset="utf-8"><body>
<table id="list"><tbody>
  <tr data-id="E"><td class="st">待发货</td><td><a class="d" href="/detail/e">订单E</a></td></tr>
</tbody></table></body>`;

const hits = {};
const resetHits = () => Object.keys(hits).forEach((k) => delete hits[k]);
/** 被刻意挂起(不响应)的连接;收尾时统一销毁,否则 server.close() 会一直等它们 */
const hanging = [];

const server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] ?? 0) + 1;
    if (req.url === '/list') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(listHtml());
    }
    if (req.url === '/detail/a') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(pinPage('A', state.aRows));
    }
    if (req.url === '/detail/b') {
        if (state.failB) {
            // 必须让 page.goto 本身抛错才会走 catch 记 failed —— HTTP 500 不抛(只会让后续选择器
            // 等到子列表超时,那是 empty 不是 failed)。而 socket.destroy() 会摧毁 keep-alive 连接,
            // 把复用同一连接的后续请求(C)一起打挂、还会被 Chromium 重试一次。
            // 干净做法:响应挂起不返回,靠 setDefaultNavigationTimeout 让本次导航超时。
            hanging.push(res);
            return undefined;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(pinPage('B', 2));
    }
    if (req.url === '/detail/c') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(blankPinPage);
    }
    if (req.url === '/list-e') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(listEHtml);
    }
    if (req.url === '/detail/e') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(noTablePage);
    }
    res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
function assertEq(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  [通过] ${name}`);
    } else {
        console.error(`  [失败] ${name}\n         实际=${a}\n         期望=${e}`);
        failed += 1;
    }
}

const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), `macro-resume-verify-${process.pid}-`));

/** 提取规则(可覆盖任意段) */
const cfg = (over = {}) => ({
    mode: 'list-detail',
    listSelector: '#list tbody tr[data-id]',
    fields: [
        { name: '订单ID', selector: '', type: 'attr', attr: 'data-id' },
        { name: '订单状态', selector: 'td.st', type: 'text' },
        { name: '详情链接', selector: 'a.d', type: 'href', hidden: true },
    ],
    detailLinkField: '详情链接',
    // 顺带回归 :has() + :text-is() 组合选择器
    detailListSelector: '#pin_form table:has(thead th:text-is("Pin")) tbody tr',
    detailFields: [
        { name: '序号', selector: 'td:nth-child(1)', type: 'text' },
        { name: 'Pin码', selector: 'td:nth-child(2)', type: 'text' },
    ],
    ...over,
});

const makeStore = (key, reuse, over = {}) =>
    createResumeStore({ dir: snapDir, key, config: cfg(over), reuse, macroName: 'resume-verify' });

let browser;
/** 跑一轮「回放 + 提取」;store=null 表示不传第 5 参(向后兼容路径) */
async function run(over = {}, store = null, pagination, listPath = '/list') {
    const page = await browser.newPage();
    // 挂起的详情页靠导航超时变成 failed;本机页面响应在毫秒级,3s 对正常页面绝无影响
    page.setDefaultNavigationTimeout(3000);
    try {
        await page.goto(`${base}${listPath}`);
        return await extract(page, cfg(over), pagination, undefined, store ?? undefined);
    } finally {
        await page.close();
    }
}

const snapPath = (key) => path.join(snapDir, `${key}.jsonl`);
/** 读快照 → {header, byPath:{'/detail/a':entry}, count} */
function readSnap(key) {
    const lines = fs.readFileSync(snapPath(key), 'utf-8').split('\n').filter((l) => l.trim());
    const header = JSON.parse(lines[0]);
    const byPath = {};
    for (let i = 1; i < lines.length; i += 1) {
        const e = JSON.parse(lines[i]);
        byPath[new URL(e.u).pathname] = e; // 端口随机,按 path 索引
    }
    return { header, byPath, count: lines.length - 1 };
}
const pinsOf = (rows, id) => rows.filter((r) => r['订单ID'] === id).map((r) => r['Pin码']);

try {
    browser = await chromium.launch({ headless: true });

    // ===== 用例 1:首跑部分失败 → 二跑只补失败项(且已成功项确实没被重新导航) =====
    console.log('\n========== 用例 1:首跑部分失败 → 二跑只补失败项 ==========');
    Object.assign(state, { failB: true, aRows: 3, status: '待发货', gen: 1 });
    resetHits();
    const r1 = await run({}, makeStore('case1', false));
    assertEq('首跑行数(A 展开 3 + B 失败 1 + C 空 1)', r1.length, 5);
    assertEq('首跑 A 的 Pin', pinsOf(r1, 'A'), ['A-PIN-1-g1', 'A-PIN-2-g1', 'A-PIN-3-g1']);
    assertEq('首跑 B 详情留空', pinsOf(r1, 'B'), ['']);
    const s1 = readSnap('case1');
    assertEq('快照头 kind/v 合法', [s1.header.kind, s1.header.v], ['resume-snapshot', 1]);
    assertEq('快照头带 sig', typeof s1.header.sig === 'string' && s1.header.sig.length === 12, true);
    assertEq('A 记 ok 且存 3 条详情值', [s1.byPath['/detail/a'].s, s1.byPath['/detail/a'].d.length], ['ok', 3]);
    assertEq('B 记 failed 且 d 为空', [s1.byPath['/detail/b'].s, s1.byPath['/detail/b'].d], ['failed', []]);
    assertEq('C 记 empty(子列表 0 命中)', s1.byPath['/detail/c'].s, 'empty');
    assertEq('快照只存详情侧字段', Object.keys(s1.byPath['/detail/a'].d[0]), ['序号', 'Pin码']);
    assertEq('首跑三个详情页各命中 1 次', [hits['/detail/a'], hits['/detail/b'], hits['/detail/c']], [1, 1, 1]);

    // 二跑:B 已修好,开补抓;同时把 Pin 值代数换成 g2 以验「复用的是旧值」
    state.failB = false;
    state.gen = 2;
    const r2 = await run({}, makeStore('case1', true));
    assertEq('二跑 A 未被重新导航(hits 仍为 1)', hits['/detail/a'], 1);
    assertEq('二跑 B 被重访', hits['/detail/b'], 2);
    assertEq('二跑 C 被重访(上次 empty)', hits['/detail/c'], 2);
    assertEq('二跑 A 复用旧值 g1', pinsOf(r2, 'A'), ['A-PIN-1-g1', 'A-PIN-2-g1', 'A-PIN-3-g1']);
    assertEq('二跑 B 抓到新值 g2', pinsOf(r2, 'B'), ['B-PIN-1-g2', 'B-PIN-2-g2']);
    assertEq('二跑行数(A3 + B2 + C1)', r2.length, 6);
    assertEq('二跑顺序仍按列表页 A→B→C', r2.map((r) => r['订单ID']), ['A', 'A', 'A', 'B', 'B', 'C']);

    // ===== 用例 2:1:N 行数由快照决定 + 列表字段取本次新值 =====
    console.log('\n========== 用例 2:1:N 行数由快照定,列表字段取新值 ==========');
    Object.assign(state, { failB: false, aRows: 3, status: '待发货', gen: 1 });
    resetHits();
    await run({}, makeStore('case2', false));
    // 二跑前:A 的明细表变成 5 行、列表状态改为「已完成」、Pin 代数换 g2
    Object.assign(state, { aRows: 5, status: '已完成', gen: 2 });
    const r3 = await run({}, makeStore('case2', true));
    assertEq('复用行数仍为 3(N 沿用上次观测值,不是新的 5)', pinsOf(r3, 'A').length, 3);
    assertEq('复用行的详情字段是旧值 g1', pinsOf(r3, 'A'), ['A-PIN-1-g1', 'A-PIN-2-g1', 'A-PIN-3-g1']);
    assertEq(
        '复用行的列表字段是本次新值(已完成)',
        r3.filter((r) => r['订单ID'] === 'A').map((r) => r['订单状态']),
        ['已完成', '已完成', '已完成']
    );
    assertEq('A 未被重新导航', hits['/detail/a'], 1);

    // ===== 用例 3:default 陷阱——配了 default 的字段不能被误判成「抓到了」 =====
    console.log('\n========== 用例 3:default 陷阱(空基线比较,不是与空串比) ==========');
    const withDefault = {
        detailFields: [
            { name: '序号', selector: 'td:nth-child(1)', type: 'text', default: '—' },
            { name: 'Pin码', selector: 'td:nth-child(2)', type: 'text', default: '—' },
        ],
    };
    Object.assign(state, { failB: false, aRows: 3, status: '待发货', gen: 1 });
    resetHits();
    const r4 = await run(withDefault, makeStore('case3', false, withDefault));
    const s3 = readSnap('case3');
    assertEq('C 的详情字段被 default 填成「—」', pinsOf(r4, 'C'), ['—']);
    assertEq('但仍判 empty(不是 ok)——default 免疫', s3.byPath['/detail/c'].s, 'empty');
    const r5 = await run(withDefault, makeStore('case3', true, withDefault));
    assertEq('故二跑仍会重抓 C', hits['/detail/c'], 2);
    assertEq('A 照旧复用', hits['/detail/a'], 1);
    assertEq('二跑仍产出 C 行(不丢单)', pinsOf(r5, 'C').length, 1);

    // ===== 用例 4:签名精度——详情侧变更作废、列表侧/出表属性变更不作废 =====
    console.log('\n========== 用例 4:签名精度 ==========');
    Object.assign(state, { failB: false, aRows: 3, status: '待发货', gen: 1 });
    // 4a 详情侧选择器变更 → 作废 + 轮转 .bak + 全量重抓
    resetHits();
    await run({}, makeStore('case4a', false));
    assertEq('4a 首跑 A 命中 1 次', hits['/detail/a'], 1);
    const changedDetail = {
        detailFields: [
            { name: '序号', selector: 'td:first-child', type: 'text' }, // 选择器改了
            { name: 'Pin码', selector: 'td:nth-child(2)', type: 'text' },
        ],
    };
    await run(changedDetail, makeStore('case4a', true, changedDetail));
    assertEq('4a 详情侧变更 → A 被重新导航(快照作废)', hits['/detail/a'], 2);
    assertEq(
        '4a 旧快照已轮转成 .bak',
        fs.readdirSync(snapDir).some((f) => f.startsWith('case4a.jsonl-') && f.endsWith('.bak')),
        true
    );
    // 4b 仅改列表侧字段 + 详情字段的 label/order/hidden → 签名不变 → 仍复用
    resetHits();
    await run({}, makeStore('case4b', false));
    const cosmetic = {
        fields: [
            { name: '订单ID', selector: '', type: 'attr', attr: 'data-id' },
            { name: '订单状态', selector: 'td.st', type: 'text' },
            { name: '详情链接', selector: 'a.d', type: 'href', hidden: true },
            { name: '新增列表列', selector: 'td.st', type: 'text' }, // 列表侧加了一列
        ],
        detailFields: [
            { name: '序号', selector: 'td:nth-child(1)', type: 'text', label: '行号', order: 9 },
            { name: 'Pin码', selector: 'td:nth-child(2)', type: 'text', hidden: true },
        ],
    };
    assertEq('4b 签名对「列表侧+出表属性」变更不敏感', resumeSignature(cfg(cosmetic)), resumeSignature(cfg()));
    const r6 = await run(cosmetic, makeStore('case4b', true, cosmetic));
    assertEq('4b A 仍被复用(未重新导航)', hits['/detail/a'], 1);
    assertEq('4b 新增的列表列也有值', r6.filter((r) => r['订单ID'] === 'A')[0]['新增列表列'], '待发货');

    // ===== 用例 5:损坏容忍 + 增量落盘 + 写模式 =====
    console.log('\n========== 用例 5:损坏容忍 / 增量落盘 / 写模式 ==========');
    Object.assign(state, { failB: false, aRows: 3, status: '待发货', gen: 1 });
    // 5a 删掉头行 → 当作无快照,全量抓,不抛
    resetHits();
    await run({}, makeStore('case5a', false));
    const lines5a = fs.readFileSync(snapPath('case5a'), 'utf-8').split('\n').filter((l) => l.trim());
    fs.writeFileSync(snapPath('case5a'), `${lines5a.slice(1).join('\n')}\n`, 'utf-8'); // 去头行
    await run({}, makeStore('case5a', true));
    assertEq('5a 头行缺失 → 全量重抓且不抛', hits['/detail/a'], 2);
    // 5b 中间插一行坏 JSON → 其余条目照复用
    resetHits();
    await run({}, makeStore('case5b', false));
    const lines5b = fs.readFileSync(snapPath('case5b'), 'utf-8').split('\n').filter((l) => l.trim());
    lines5b.splice(2, 0, '{这不是合法 JSON');
    fs.writeFileSync(snapPath('case5b'), `${lines5b.join('\n')}\n`, 'utf-8');
    await run({}, makeStore('case5b', true));
    assertEq('5b 单行坏 JSON 被跳过,A 仍复用', hits['/detail/a'], 1);
    // 5c 增量落盘:第 3 项前被取消 → 抛错,但前 2 项已在快照里
    resetHits();
    let calls = 0;
    const pagination = {
        totalPages: 1,
        turnPage: async () => {},
        isCancelled: () => {
            calls += 1;
            return calls > 2; // 前两项放行,第三项前判定已取消
        },
    };
    let threw = '';
    try {
        await run({}, makeStore('case5c', false), pagination);
    } catch (e) {
        threw = e.message;
    }
    assertEq('5c 取消时 extract 原样抛错(不再吞成正常返回)', threw, '回放已被用户停止。');
    assertEq('5c 但前 2 项已增量落盘', readSnap('case5c').count, 2);
    // 5d 写模式:压实(写回旧条目)+ append —— 行数稳定不无界增长,同键取最新值
    resetHits();
    await run({}, makeStore('case5d', false));
    assertEq('5d 首次全量跑 3 条', readSnap('case5d').count, 3);
    await run({}, makeStore('case5d', false));
    assertEq('5d 再次全量跑 = 3 旧 + 3 新(压实写回旧记录,不是丢弃)', readSnap('case5d').count, 6);
    await run({}, makeStore('case5d', false));
    assertEq('5d 第三次仍是 6 条(稳定在 2× 键数,不无界增长)', readSnap('case5d').count, 6);
    assertEq('5d 去重后恒为 3 个键', Object.keys(readSnap('case5d').byPath).length, 3);

    // 5f 「忘勾补抓又跑了一次、而且中途还停了」:上一轮的成功记录必须仍在 —— 压实的核心价值。
    //    (旧实现用 truncate,此处 B 的记录会被本轮削掉,补抓时只能重抓)
    resetHits();
    await run({}, makeStore('case5f', false)); // 首轮:A ok / B ok / C empty
    let calls5f = 0;
    const cancelAfterFirst = {
        totalPages: 1,
        turnPage: async () => {},
        isCancelled: () => {
            calls5f += 1;
            return calls5f > 1; // 只放行第 1 项,第 2 项前中断
        },
    };
    try {
        await run({}, makeStore('case5f', false), cancelAfterFirst);
    } catch {
        /* 预期:取消时原样抛错 */
    }
    const s5f = readSnap('case5f');
    assertEq('5f 中断后 A 的记录仍在', s5f.byPath['/detail/a'].s, 'ok');
    assertEq('5f 中断后 B 的记录也仍在(没被本轮削掉)', s5f.byPath['/detail/b'].s, 'ok');
    resetHits();
    await run({}, makeStore('case5f', true));
    assertEq(
        '5f 随后补抓:A、B 都仍可复用(一次都不必重访)',
        [hits['/detail/a'] ?? 0, hits['/detail/b'] ?? 0],
        [0, 0]
    );

    // 5e 子列表 0 命中(完全没有明细表)也记 empty、仍保 1 行不丢单。
    //    单独一轮:这条路径要等满 DETAIL_LIST_SETTLE_TIMEOUT(15s),只付一次。
    resetHits();
    const rE = await run({}, makeStore('case5e', false), undefined, '/list-e');
    assertEq('5e 0 命中仍保 1 行(不丢单)', rE.length, 1);
    assertEq('5e 该行详情字段留空', rE[0]['Pin码'], '');
    assertEq('5e 记为 empty', readSnap('case5e').byPath['/detail/e'].s, 'empty');
    const rE2 = await run({}, makeStore('case5e', true), undefined, '/list-e');
    assertEq('5e 二跑仍重抓(empty 不算已完成)', hits['/detail/e'], 2);
    assertEq('5e 二跑仍保 1 行', rE2.length, 1);

    // ===== 用例 6(末位恒为向后兼容):不传第 5 参 → 行为与现状一字不差、零文件产生 =====
    console.log('\n========== 用例 6:不传 resume 参数完全向后兼容 ==========');
    Object.assign(state, { failB: false, aRows: 3, status: '待发货', gen: 1 });
    const before = fs.readdirSync(snapDir).length;
    resetHits();
    const r7 = await run({}, null);
    assertEq('未传 resume:A 展开 3 行', pinsOf(r7, 'A'), ['A-PIN-1-g1', 'A-PIN-2-g1', 'A-PIN-3-g1']);
    assertEq('未传 resume:C 子列表 0 命中仍保 1 行', pinsOf(r7, 'C'), ['']);
    assertEq('未传 resume:总行数 3+2+1', r7.length, 6);
    assertEq('未传 resume:每个详情页都被正常导航', [hits['/detail/a'], hits['/detail/b'], hits['/detail/c']], [1, 1, 1]);
    assertEq('未传 resume:快照目录无新增文件', fs.readdirSync(snapDir).length, before);
} finally {
    if (browser) {
        await browser.close();
    }
    // 先放掉刻意挂起的连接,否则 server.close() 会一直等它们
    for (const res of hanging) {
        try {
            res.destroy();
        } catch {
            /* 已断开:忽略 */
        }
    }
    server.close();
    try {
        fs.rmSync(snapDir, { recursive: true, force: true });
    } catch {
        /* 清理失败不影响结论 */
    }
}

if (failed > 0) {
    console.error(`\n补抓自检未通过:${failed} 处失败。`);
    process.exit(1);
}
console.log('\n补抓自检全部通过。');
