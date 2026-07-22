// list-action 行级筛选离线自检:直接驱动编译后的 extract(),
// 用合成列表页记录点击,断言「只有匹配筛选条件的行才执行动作」。
// 覆盖:内置 text / AND / OR / exists / 数值强转 / attr 取值 / 无 filter 向后兼容 / 失败即安全。
// 需先 `npm run build`。用法:node scripts/verify-list-action-filter.mjs
//   本机缺 headless chromium 时前置:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extract } = require('../dist/core/extractor.js');
const { chromium } = require('playwright');

if (typeof extract !== 'function') {
    console.error('未导出 extract,请确认已 npm run build');
    process.exit(1);
}

// 合成列表页:4 行,每行含 .status 文本 / .price 文本 / 可选 .vip 徽章 / .download 按钮。
// 行 0 额外带 data-flag="hot"。每次点 .download 把 download#i push 到 window.__clicks 供断言。
//   行0: 已完成 200 VIP  (data-flag=hot)
//   行1: 待处理 50
//   行2: 已完成 80
//   行3: 待处理 300 VIP
const HTML = `<!doctype html><meta charset="utf-8"><body>
<div id="list">
  <div class="item" data-flag="hot" style="height:50px"><span class="status">已完成</span><span class="price">200</span><span class="vip">VIP</span><button type="button" class="download" data-i="0">下载</button></div>
  <div class="item" style="height:50px"><span class="status">待处理</span><span class="price">50</span><button type="button" class="download" data-i="1">下载</button></div>
  <div class="item" style="height:50px"><span class="status">已完成</span><span class="price">80</span><button type="button" class="download" data-i="2">下载</button></div>
  <div class="item" style="height:50px"><span class="status">待处理</span><span class="price">300</span><span class="vip">VIP</span><button type="button" class="download" data-i="3">下载</button></div>
</div>
<script>
  window.__clicks = [];
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('download')) { window.__clicks.push('download#' + t.dataset.i); }
  }, true);
</script>
</body>`;

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

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// filter 缺省时按普通 list-action 处理;传 filter 则逐行筛选
async function runCase(filter) {
    await page.setContent(HTML);
    await page.evaluate(() => {
        window.__clicks = [];
    });
    const config = { mode: 'list-action', listSelector: '.item', actionSelector: '.download' };
    if (filter !== undefined) {
        config.filter = filter;
    }
    // 不传 pagination / downloads:单页处理、每次点击不等下载(纯验证筛选后点击集合)
    await extract(page, config, undefined, undefined);
    return page.evaluate(() => window.__clicks);
}

const priceVar = { name: 'price', selector: '.price', scope: 'item', source: 'text' };

try {
    // A 内置 text:含"已完成"的行(0、2)
    assertEq(
        'A 内置 text 含关键词',
        await runCase({ conditions: ['contains(text, "已完成")'] }),
        ['download#0', 'download#2']
    );

    // B AND:已完成 且 price>100 → 仅行0
    assertEq(
        'B AND(text + 数值)',
        await runCase({ match: 'all', vars: [priceVar], conditions: ['contains(text, "已完成")', 'price > 100'] }),
        ['download#0']
    );

    // C OR:待处理 或 price>250 → 行1、行3
    assertEq(
        'C OR(text 或 数值)',
        await runCase({ match: 'any', vars: [priceVar], conditions: ['contains(text, "待处理")', 'price > 250'] }),
        ['download#1', 'download#3']
    );

    // D exists:有 .vip 的行(0、3)
    assertEq(
        'D exists 徽章存在',
        await runCase({ vars: [{ name: 'vip', selector: '.vip', source: 'exists' }], conditions: ['vip'] }),
        ['download#0', 'download#3']
    );

    // E 数值强转:字符串 price >= 200 → 行0、行3
    assertEq(
        'E 数值比较(字符串强转)',
        await runCase({ vars: [priceVar], conditions: ['price >= 200'] }),
        ['download#0', 'download#3']
    );

    // F attr 取值 + 空 selector 取行本身 + 松散相等:仅行0 data-flag=hot
    assertEq(
        'F attr 取值(行本身属性)',
        await runCase({
            vars: [{ name: 'flag', selector: '', scope: 'item', source: 'attr', attr: 'data-flag' }],
            conditions: ['flag == "hot"'],
        }),
        ['download#0']
    );

    // G 无 filter:全点击(向后兼容)
    assertEq('G 无 filter 全执行', await runCase(undefined), ['download#0', 'download#1', 'download#2', 'download#3']);

    // H 空 conditions:视为不筛选,全点击
    assertEq(
        'H 空条件视为不筛选',
        await runCase({ match: 'all', vars: [priceVar], conditions: ['', '   '] }),
        ['download#0', 'download#1', 'download#2', 'download#3']
    );

    // I 失败即安全:引用未声明变量 → 求值失败判 false → all 下全跳过
    assertEq('I 失败即安全(未声明变量)', await runCase({ conditions: ['contains(missingvar, "x")'] }), []);

    // J 失败即安全:语法非法(白名单外算子 +)→ 解析失败判 false → 全跳过
    assertEq('J 失败即安全(语法非法)', await runCase({ conditions: ['price + 1 > 2'] }), []);
} finally {
    await browser.close();
}

if (failed > 0) {
    console.error(`\n自检失败:共 ${failed} 处不符合预期`);
    process.exit(1);
}
console.log('\n自检通过:list-action 行级筛选语义符合预期');
