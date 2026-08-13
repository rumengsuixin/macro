// 「追加式加载更多」翻页自检(离线):点击后旧行仍在 DOM、新行追加在末尾的站点(如 1epin 的 #showMore),
// 提取端须只采本轮新增的行,否则第 N 批会把前 N-1 批全部重采一遍(行数 3+6+9 膨胀)。
//
// 用例 1-5 直接驱动编译后的 extract()(合成页,setContent,无需服务);
// 用例 6 走 MacroRunner 端到端(本机 http 服务),验证宏步骤上的 paginationAppend 标记确实接线到提取端。
//
// 需先 `npm run build`。用法:MACRO_HEADLESS=1 node scripts/verify-pagination-append.mjs
//   本机缺 headless chromium 时前置:PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { extract } = require('../dist/core/extractor.js');
const { MacroRunner } = require('../dist/core/macro-runner.js');
const { chromium } = require('playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

if (typeof extract !== 'function') {
    console.error('未导出 extract,请确认已 npm run build');
    process.exit(1);
}

let failed = 0;
const check = (cond, okMsg, badMsg) => {
    if (cond) {
        console.log('  ✅', okMsg);
    } else {
        console.log('  ❌', badMsg);
        failed += 1;
    }
};

const BATCH = 3; // 每批 3 项
const MAX_BATCH = 3; // 共 3 批 = 9 项,第 3 批加载后按钮移除

// 合成「加载更多」页:#showMore 每点一次向同一 tbody **追加** 3 行(旧行不消失),
// 满 3 批后按钮从 DOM 移除(模拟真实站点「没有更多了」)。
// ?dead=1:按钮永远在,但点了不追加任何行(模拟死按钮),用于验证「项数未增加即收尾」。
const HTML = `<!doctype html><meta charset="utf-8"><body>
<table id="myTable"><tbody id="tb"></tbody></table>
<button id="showMore" style="margin-top:8px">加载更多</button>
<script>
  var batch = 0;
  window.__clicks = [];
  function addBatch() {
    batch += 1;
    var tb = document.getElementById('tb');
    for (var i = 1; i <= ${BATCH}; i += 1) {
      var tr = document.createElement('tr');
      tr.className = 'item';
      tr.setAttribute('data-id', batch + '-' + i);
      tr.innerHTML = '<td class="t">第' + batch + '批-第' + i + '项</td>' +
                     '<td><button class="act" data-k="' + batch + '-' + i + '">下载</button></td>';
      tb.appendChild(tr);
    }
    if (batch >= ${MAX_BATCH}) {
      var btn = document.getElementById('showMore');
      if (btn) { btn.remove(); }
    }
  }
  addBatch(); // 首屏第 1 批
  document.getElementById('showMore').addEventListener('click', function () {
    if (window.__dead) { return; } // 死按钮:点了什么也不发生
    addBatch();
  });
  document.addEventListener('click', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('act')) {
      window.__clicks.push(e.target.dataset.k);
    }
  });
</script>
</body>`;

const SETTLE_MS = 1500; // 短 settle:死按钮/替换式确认失败时不必等满默认 30s
const LIST_CONFIG = {
    mode: 'list',
    listSelector: '#myTable tbody tr.item',
    fields: [{ name: '文本', selector: '.t', type: 'text' }],
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

/** 构造翻页上下文:turnPage = 点一次 #showMore(按钮已移除时抛错 → 提取端判为到底) */
const makePagination = (totalPages, appendMode) => ({
    totalPages,
    appendMode,
    settleTimeoutMs: SETTLE_MS,
    perPageDelayMs: 0,
    turnPage: async () => {
        await page.click('#showMore', { timeout: SETTLE_MS });
    },
});

const loadPage = async (dead = false) => {
    await page.setContent(HTML);
    // 必须显式写回 __dead:setContent 只换文档不换 window,上个用例设的标志会活到下个用例
    await page.evaluate((d) => {
        window.__dead = d;
    }, dead);
};

try {
    // ========== ① 追加式 + 不限次数 ==========
    console.log('\n[1] 追加式 + pageCount:0(不限):点到按钮消失,零重复');
    await loadPage();
    let rows = await extract(page, LIST_CONFIG, makePagination(0, true));
    let texts = rows.map((r) => r['文本']);
    check(
        rows.length === BATCH * MAX_BATCH,
        `采到 ${BATCH * MAX_BATCH} 行(3 批 × 3 项),无重复膨胀`,
        `行数期望 ${BATCH * MAX_BATCH},实际 ${rows.length}(疑似重采:${texts.join('|')})`
    );
    check(
        new Set(texts).size === rows.length,
        '9 行内容互不相同(确实只采新增行)',
        `存在重复行:${JSON.stringify(texts)}`
    );
    check(
        texts[0] === '第1批-第1项' && texts[rows.length - 1] === `第${MAX_BATCH}批-第${BATCH}项`,
        '首尾行正确(首批在前、末批在后,顺序未错乱)',
        `首尾异常:${texts[0]} … ${texts[rows.length - 1]}`
    );

    // ========== ② 追加式 + 有界(页数闸门仍有效) ==========
    console.log('\n[2] 追加式 + pageCount:2:只采前 2 批,闸门仍有效');
    await loadPage();
    rows = await extract(page, LIST_CONFIG, makePagination(2, true));
    texts = rows.map((r) => r['文本']);
    check(
        rows.length === BATCH * 2,
        `只采 ${BATCH * 2} 行(2 批 × 3 项),未越界也未重复`,
        `行数期望 ${BATCH * 2},实际 ${rows.length}:${texts.join('|')}`
    );
    check(
        new Set(texts).size === rows.length && !texts.includes('第3批-第1项'),
        '内容为第 1、2 批且无重复',
        `内容异常:${JSON.stringify(texts)}`
    );

    // ========== ③ 不标追加式的回归(旧路径逐字节不变) ==========
    console.log('\n[3] 同一页面不标追加式 + pageCount:3:仍是历史行为(整表重采,3+6+9=18 行)');
    await loadPage();
    rows = await extract(page, LIST_CONFIG, makePagination(3, false));
    check(
        rows.length === 3 + 6 + 9,
        '仍为 18 行(证明整页替换路径未被改动,旧宏行为不变)',
        `行数期望 18,实际 ${rows.length}`
    );

    // ========== ④ 死按钮:点了不新增行 ==========
    console.log('\n[4] 追加式 + 不限 + 死按钮(点了不追加):靠「项数未增加」收尾,不死循环');
    await loadPage(true);
    const t0 = Date.now();
    rows = await extract(page, LIST_CONFIG, makePagination(0, true));
    const cost = Date.now() - t0;
    check(
        rows.length === BATCH,
        `只采首批 ${BATCH} 行后停止`,
        `行数期望 ${BATCH},实际 ${rows.length}`
    );
    check(cost < SETTLE_MS * 4, `及时收尾(耗时 ${cost}ms,未卡死)`, `收尾过慢:${cost}ms`);

    // ========== ⑤ list-action + 追加式:不重复点已点过的行 ==========
    console.log('\n[5] list-action + 追加式 + 不限:每项只点一次');
    await loadPage();
    await extract(
        page,
        {
            mode: 'list-action',
            listSelector: '#myTable tbody tr.item',
            actionSelector: '.act',
            actionTimeout: SETTLE_MS,
        },
        makePagination(0, true)
    );
    const clicks = await page.evaluate(() => window.__clicks);
    check(
        clicks.length === BATCH * MAX_BATCH,
        `共点击 ${BATCH * MAX_BATCH} 次(每项恰好一次,非 3+6+9=18 次)`,
        `点击次数期望 ${BATCH * MAX_BATCH},实际 ${clicks.length}:${clicks.join(',')}`
    );
    check(
        new Set(clicks).size === clicks.length,
        '无任何一项被重复点击',
        `存在重复点击:${JSON.stringify(clicks)}`
    );
} catch (err) {
    console.log('  ❌ 用例异常:', err && err.message);
    failed += 1;
} finally {
    await browser.close();
}

// ========== ⑥ 端到端:宏步骤 paginationAppend 标记 → 提取端接线 ==========
console.log('\n[6] MacroRunner 端到端:步骤标 paginationAppend:true + pageCount:0');
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
fs.mkdirSync(path.join(root, 'errors'), { recursive: true });

const replayProfile = {
    globalTimeoutMs: 6000,
    stepTimeoutMs: {},
    retry: { count: 0, backoff: 'fixed', baseMs: 500, factor: 2, maxMs: 10000 },
    stepDelay: { min: 0, max: 0 },
    onError: 'abort',
    onErrorByType: {},
    pagination: { settleTimeoutMs: SETTLE_MS, perPageDelayMs: 0 },
    scrollBottomWaitMs: 200,
};

try {
    const runner = new MacroRunner(path.join(root, 'errors'), 6000, undefined, { replayProfile });
    const result = await Promise.race([
        runner.run({
            name: 'pagination-append-e2e',
            version: 1,
            steps: [
                { type: 'goto', url: `http://127.0.0.1:${port}/append` },
                {
                    type: 'click',
                    selector: '#showMore',
                    pagination: true,
                    pageCount: 0,
                    paginationAppend: true,
                },
            ],
            extract: LIST_CONFIG,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('自检硬超时(90s)')), 90000)),
    ]);
    check(result?.ok === true, '回放成功完成', `回放未成功:${result?.error?.message}`);
    const e2eTexts = (result?.rows || []).map((r) => r['文本']);
    check(
        e2eTexts.length === BATCH * MAX_BATCH && new Set(e2eTexts).size === e2eTexts.length,
        `端到端采到 ${BATCH * MAX_BATCH} 行且零重复(步骤标记已正确接线)`,
        `行数/重复异常:${e2eTexts.length} 行 → ${JSON.stringify(e2eTexts)}`
    );
} catch (err) {
    console.log('  ❌ 端到端异常:', err && err.message);
    failed += 1;
} finally {
    server.close();
}

console.log(
    failed > 0
        ? `\n❌ 自检未通过:共 ${failed} 处不符合预期\n`
        : '\n✅ 全部通过:追加式加载更多只采新增行,零重复;整页替换路径不受影响\n'
);
process.exit(failed > 0 ? 2 : 0);
