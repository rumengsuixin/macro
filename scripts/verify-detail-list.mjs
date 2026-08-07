// list-detail「详情页多行展开」离线自检:直接驱动编译后的 extract(),
// 用本机 http 服务起「列表页 + 两个详情页」,断言 detailListSelector 的 1:N 展开语义。
// 覆盖:多行展开 / 父字段逐行重复 / 子字段逐行不同 / 子列表 0 命中仍保一行 / 不设该字段时向后兼容。
// 需先 `npm run build`。用法:node scripts/verify-detail-list.mjs
//   本机缺 headless chromium 时前置:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extract } = require('../dist/core/extractor.js');
const { chromium } = require('playwright');

if (typeof extract !== 'function') {
    console.error('未导出 extract,请确认已 npm run build');
    process.exit(1);
}

// 列表页:2 个订单,各带一个进详情页的链接
const LIST_HTML = `<!doctype html><meta charset="utf-8"><body>
<table id="myTable"><tbody>
  <tr data-id="A"><td><a class="no" href="/detail/a">#订单A</a></td></tr>
  <tr data-id="B"><td><a class="no" href="/detail/b">#订单B</a></td></tr>
</tbody></table>
</body>`;

// 详情页 A:一张 3 行的明细表(模拟一单多 Pin)
const DETAIL_A = `<!doctype html><meta charset="utf-8"><body>
<div id="pin_form"><table>
  <thead><tr><th>#</th><th>Sec</th><th>Pin</th></tr></thead>
  <tbody>
    <tr><td>1.</td><td><input name="sec" value="p001"></td><td>PIN-AAA</td></tr>
    <tr><td>2.</td><td><input name="sec" value="p002"></td><td>PIN-BBB</td></tr>
    <tr><td>3.</td><td><input name="sec" value="p003"></td><td>PIN-CCC</td></tr>
  </tbody>
</table></div>
</body>`;

// 详情页 B:没有明细表(子列表 0 命中)
const DETAIL_B = `<!doctype html><meta charset="utf-8"><body>
<div id="empty">该订单暂无明细</div>
</body>`;

const server = http.createServer((req, res) => {
    const routes = { '/list': LIST_HTML, '/detail/a': DETAIL_A, '/detail/b': DETAIL_B };
    const body = routes[req.url];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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

// 列表页字段:订单ID(行 data-id)/ 订单名(链接文本,去前导 #)/ 详情链接(href,隐藏列)
const LIST_FIELDS = [
    { name: '订单ID', selector: '', type: 'attr', attr: 'data-id' },
    {
        name: '订单名',
        selector: 'a.no',
        type: 'text',
        transform: [{ op: 'replace', pattern: '^#', to: '' }],
    },
    { name: '详情链接', selector: 'a.no', type: 'href', hidden: true },
];
// 详情字段:展开时相对「明细行」求值,不展开时整页求值
const DETAIL_FIELDS = [
    {
        name: '序号',
        selector: 'td:nth-child(1)',
        type: 'text',
        transform: [{ op: 'replace', pattern: '\\.$', to: '' }],
    },
    { name: 'PinID', selector: 'td:nth-child(2) input[name="sec"]', type: 'attr', attr: 'value' },
    { name: 'Pin码', selector: 'td:nth-child(3)', type: 'text' },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

async function run(config) {
    await page.goto(`${base}/list`, { waitUntil: 'domcontentloaded' });
    return extract(page, config);
}

try {
    // ===== 用例 1:设了 detailListSelector → 1:N 展开 =====
    console.log('用例 1:detailListSelector 展开详情页明细');
    const rows = await run({
        mode: 'list-detail',
        listSelector: '#myTable tbody tr[data-id]',
        fields: LIST_FIELDS,
        detailLinkField: '详情链接',
        detailListSelector: '#pin_form table:has(thead th:text-is("Pin")) tbody tr',
        detailFields: DETAIL_FIELDS,
    });

    // A 出 3 行(3 条明细)、B 出 1 行(0 命中兜底)→ 共 4 行
    assertEq('总行数 = 3(A 三条明细) + 1(B 无明细兜底)', rows.length, 4);
    assertEq(
        '父字段在 A 的三行里原样重复',
        rows.slice(0, 3).map((r) => `${r['订单ID']}/${r['订单名']}`),
        ['A/订单A', 'A/订单A', 'A/订单A']
    );
    assertEq(
        '子字段逐行取到各自的值',
        rows.slice(0, 3).map((r) => `${r['序号']}-${r['PinID']}-${r['Pin码']}`),
        ['1-p001-PIN-AAA', '2-p002-PIN-BBB', '3-p003-PIN-CCC']
    );
    assertEq('子列表 0 命中的订单仍保一行,不丢单', rows[3]['订单ID'], 'B');
    assertEq(
        '0 命中行的详情字段填空,列对齐',
        [rows[3]['序号'], rows[3]['PinID'], rows[3]['Pin码']],
        ['', '', '']
    );
    assertEq(
        '各行列集合一致(导出不会缺列)',
        rows.map((r) => Object.keys(r).sort().join(',')),
        Array(4).fill(['订单ID', '订单名', '详情链接', '序号', 'PinID', 'Pin码'].sort().join(','))
    );

    // ===== 用例 2:不设 detailListSelector → 完全沿用旧语义(一项一行) =====
    console.log('用例 2:不设 detailListSelector 时向后兼容');
    const legacy = await run({
        mode: 'list-detail',
        listSelector: '#myTable tbody tr[data-id]',
        fields: LIST_FIELDS,
        detailLinkField: '详情链接',
        detailFields: [{ name: '首个Pin', selector: '#pin_form tbody td:nth-child(3)', type: 'text' }],
    });
    assertEq('两个订单各出一行', legacy.length, 2);
    assertEq(
        '详情字段按整页求值(取到首个明细)',
        legacy.map((r) => r['首个Pin']),
        ['PIN-AAA', '']
    );
} finally {
    await browser.close();
    server.close();
}

if (failed > 0) {
    console.error(`\n详情页多行展开自检失败:${failed} 项。`);
    process.exit(1);
}
console.log('\n详情页多行展开自检全部通过。');
