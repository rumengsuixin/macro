// list-action 动作级筛选(gate)+ 收尾动作(finally)离线自检:直接驱动编译后的 extract()。
// 场景:每行一个「打开」按钮 → 点开弹出「全屏遮罩弹窗」(会遮住其它行)→ 弹窗内取值做动作级 gate →
//       命中才点「下载」,随后点「标记」,最后收尾动作「关闭」总会执行清场。
// 断言:① gate 命中集正确(值只在弹窗打开后才可读,验证「动作中途按弹窗内容过滤」);
//       ② onFilterFail=abort vs skip 差异(abort 连后续 mark 一起中止;skip 只跳过下载、mark 照跑);
//       ③ finally 每行都关掉弹窗 —— 以「所有行都成功点开(opens=[0,1,2,3])」为证:
//          若某行收尾没关弹窗,遮罩会挡住下一行「打开」→ Playwright 点击超时 → 该行 open 不会被记录。
// 需先 `npm run build`。用法:node scripts/verify-list-action-action-filter.mjs
//   本机缺 headless chromium 时前置:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extract } = require('../dist/core/extractor.js');
const { chromium } = require('playwright');

if (typeof extract !== 'function') {
    console.error('未导出 extract,请确认已 npm run build');
    process.exit(1);
}

// 4 行,每行一个 .open(带 data-type / data-amount);共用一个全屏遮罩弹窗 #modal。
//   行0: 向多人转账 200   行1: 普通转账 50   行2: 向多人转账 80   行3: 普通转账 300
const HTML = `<!doctype html><meta charset="utf-8"><style>
  #modal{position:fixed;inset:0;display:none;background:rgba(0,0,0,.4);z-index:9999}
  #modal .box{position:absolute;top:30%;left:30%;background:#fff;padding:20px}
  .item{height:40px}
</style><body>
<div id="list">
  <div class="item"><button class="open" data-i="0" data-type="向多人转账" data-amount="200">打开</button></div>
  <div class="item"><button class="open" data-i="1" data-type="普通转账" data-amount="50">打开</button></div>
  <div class="item"><button class="open" data-i="2" data-type="向多人转账" data-amount="80">打开</button></div>
  <div class="item"><button class="open" data-i="3" data-type="普通转账" data-amount="300">打开</button></div>
</div>
<div id="modal"><div class="box">
  <span id="modal-type"></span> <span id="modal-amount"></span>
  <button id="modal-download">下载</button>
  <button id="modal-mark">标记</button>
  <button id="modal-close">关闭</button>
</div></div>
<script>
  window.__opens = []; window.__downloads = []; window.__marks = []; window.__cur = null;
  var modal = document.getElementById('modal');
  var mtype = document.getElementById('modal-type');
  var mamount = document.getElementById('modal-amount');
  document.querySelectorAll('.open').forEach(function (b) {
    b.addEventListener('click', function () {
      var i = Number(b.dataset.i);
      window.__cur = i; window.__opens.push(i);
      mtype.textContent = b.dataset.type; mamount.textContent = b.dataset.amount;
      modal.style.display = 'block';
    });
  });
  document.getElementById('modal-download').addEventListener('click', function () { window.__downloads.push(window.__cur); });
  document.getElementById('modal-mark').addEventListener('click', function () { window.__marks.push(window.__cur); });
  document.getElementById('modal-close').addEventListener('click', function () { modal.style.display = 'none'; });
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

// gated=false → 下载动作无 gate(全下载);否则挂 gate,onFail 控制不满足时处置。
// gateKind: 'type'(mtype=="向多人转账")或 'amount'(amount>100)。
function buildConfig({ gated = true, onFail = 'abort', gateKind = 'type' } = {}) {
    const download = { selector: '#modal-download', scope: 'page', waitFor: '#modal' };
    if (gated) {
        download.onFilterFail = onFail;
        download.filter =
            gateKind === 'amount'
                ? {
                      vars: [{ name: 'amount', selector: '#modal-amount', scope: 'page', source: 'text' }],
                      conditions: ['amount > 100'],
                  }
                : {
                      vars: [{ name: 'mtype', selector: '#modal-type', scope: 'page', source: 'text' }],
                      conditions: ['mtype == "向多人转账"'],
                  };
    }
    return {
        mode: 'list-action',
        listSelector: '.item',
        actionTimeout: 3000, // 收尾若失效,后续行被遮罩挡住会在此超时内快速暴露,而非久等
        actionSelector: [
            '.open', // ① 项内:点开本行 → 弹窗显示本行值
            download, // ② 全局:弹窗内「下载」,挂动作级 gate
            { selector: '#modal-mark', scope: 'page' }, // ③ 全局:弹窗内「标记」(用于区分 abort/skip)
            { selector: '#modal-close', scope: 'page', finally: true }, // ④ 收尾:总会关弹窗清场
        ],
    };
}

async function runCase(opts) {
    await page.setContent(HTML);
    await extract(page, buildConfig(opts), undefined, undefined);
    return page.evaluate(() => ({
        opens: window.__opens,
        downloads: window.__downloads,
        marks: window.__marks,
        modalOpen: document.getElementById('modal').style.display === 'block',
    }));
}

try {
    // A 无 gate:全下载 + 全标记;finally 每行清场 → 4 行全部成功点开
    {
        const r = await runCase({ gated: false });
        assertEq('A 无 gate·下载集', r.downloads, [0, 1, 2, 3]);
        assertEq('A 无 gate·标记集', r.marks, [0, 1, 2, 3]);
        assertEq('A 无 gate·全行点开(证明 finally 清场)', r.opens, [0, 1, 2, 3]);
        assertEq('A 无 gate·末态弹窗已关', r.modalOpen, false);
    }

    // B gate(type)+abort:命中行 0/2 才下载;abort 使非命中行连 mark 一起中止
    {
        const r = await runCase({ gated: true, onFail: 'abort', gateKind: 'type' });
        assertEq('B abort·下载集(仅命中)', r.downloads, [0, 2]);
        assertEq('B abort·标记集(非命中一并中止)', r.marks, [0, 2]);
        assertEq('B abort·全行点开(finally 照跑清场)', r.opens, [0, 1, 2, 3]);
        assertEq('B abort·末态弹窗已关', r.modalOpen, false);
    }

    // C gate(type)+skip:命中行 0/2 才下载;skip 仅跳过下载,mark 对所有行照跑
    {
        const r = await runCase({ gated: true, onFail: 'skip', gateKind: 'type' });
        assertEq('C skip·下载集(仅命中)', r.downloads, [0, 2]);
        assertEq('C skip·标记集(全行照跑)', r.marks, [0, 1, 2, 3]);
        assertEq('C skip·全行点开', r.opens, [0, 1, 2, 3]);
        assertEq('C skip·末态弹窗已关', r.modalOpen, false);
    }

    // D gate(amount>100,弹窗内数值)+abort:命中行 0(200)/3(300)
    {
        const r = await runCase({ gated: true, onFail: 'abort', gateKind: 'amount' });
        assertEq('D abort·数值 gate 下载集', r.downloads, [0, 3]);
        assertEq('D abort·数值 gate 标记集', r.marks, [0, 3]);
        assertEq('D abort·全行点开', r.opens, [0, 1, 2, 3]);
    }
} finally {
    await browser.close();
}

if (failed > 0) {
    console.error(`\n自检失败:共 ${failed} 处不符合预期`);
    process.exit(1);
}
console.log('\n自检通过:list-action 动作级筛选(gate)+ 收尾动作(finally)语义符合预期');
