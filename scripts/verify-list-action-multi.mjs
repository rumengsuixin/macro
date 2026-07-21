// list-action 多动作 + scope 离线自检:直接驱动编译后的 extract(),
// 用合成列表页记录点击顺序,断言「向后兼容单字符串 / 多动作依次点击 / scope 项内-全局」三种语义。
// 需先 `npm run build`。用法:node scripts/verify-list-action-multi.mjs
//   本机缺 headless chromium 时前置:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extract } = require('../dist/core/extractor.js');
const { chromium } = require('playwright');

if (typeof extract !== 'function') {
    console.error('未导出 extract,请确认已 npm run build');
    process.exit(1);
}

// 合成列表页:3 项,每项含「展开(项内).expand」「下载(项内).download」按钮;另有全局按钮 #global-btn。
// 每次点击把标识 push 到 window.__clicks,供断言点击顺序。
// 列表项给足高度,使按钮居左上、项中心为空——空动作时 Playwright 点项中心命中项容器本身而非按钮。
const HTML = `<!doctype html><meta charset="utf-8"><body>
<div id="list">
  <div class="item" style="height:60px"><button type="button" class="expand" data-i="0">展开</button><button type="button" class="download" data-i="0">下载</button></div>
  <div class="item" style="height:60px"><button type="button" class="expand" data-i="1">展开</button><button type="button" class="download" data-i="1">下载</button></div>
  <div class="item" style="height:60px"><button type="button" class="expand" data-i="2">展开</button><button type="button" class="download" data-i="2">下载</button></div>
</div>
<button type="button" id="global-btn">全局确认</button>
<script>
  window.__clicks = [];
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.id === 'global-btn') { window.__clicks.push('global'); return; }
    if (t.classList.contains('expand')) { window.__clicks.push('expand#' + t.dataset.i); return; }
    if (t.classList.contains('download')) { window.__clicks.push('download#' + t.dataset.i); return; }
    if (t.classList.contains('item')) { window.__clicks.push('item'); return; }
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

async function runCase(name, actionSelector) {
    await page.setContent(HTML);
    await page.evaluate(() => { window.__clicks = []; });
    // 不传 pagination / downloads:单页处理、每次点击不等下载(纯验证点击序列与 scope)
    await extract(page, { mode: 'list-action', listSelector: '.item', actionSelector }, undefined, undefined);
    return page.evaluate(() => window.__clicks);
}

try {
    // 用例 A:向后兼容——单字符串(项内),每项点一次 .download
    assertEq(
        'A 单字符串向后兼容',
        await runCase('A', '.download'),
        ['download#0', 'download#1', 'download#2']
    );

    // 用例 B:多动作依次点击——每项先 .expand 再 .download(均项内)
    assertEq(
        'B 多动作依次点击(项内)',
        await runCase('B', ['.expand', '.download']),
        ['expand#0', 'download#0', 'expand#1', 'download#1', 'expand#2', 'download#2']
    );

    // 用例 C:scope 混合——每项先点项内 .download,再点全局 #global-btn(scope=page)
    assertEq(
        'C scope 项内+全局混合',
        await runCase('C', [{ selector: '.download', scope: 'item' }, { selector: '#global-btn', scope: 'page' }]),
        ['download#0', 'global', 'download#1', 'global', 'download#2', 'global']
    );

    // 用例 D:空动作——留空点列表项本身(点项中心命中项容器,记 'item')
    assertEq('D 空动作点列表项本身', await runCase('D', ''), ['item', 'item', 'item']);
} finally {
    await browser.close();
}

if (failed > 0) {
    console.error(`\n自检失败:共 ${failed} 处不符合预期`);
    process.exit(1);
}
console.log('\n自检通过:list-action 多动作 + scope 语义符合预期');
