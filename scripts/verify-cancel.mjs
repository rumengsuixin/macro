// 停止/中断回放离线自检。两个用例(取消语义的唯一事实源,新增取消相关行为都往这里加):
//
// 用例 1「卡在慢步骤」:宏 = [goto, waitForSelector #never timeout 30s],正常会卡 30 秒才超时。
//   800ms 后调 runner.cancel(),断言 ①远早于 30s 返回(确实被打断)②result.cancelled===true。
//
// 用例 2「卡在提取阶段」(回归 list-detail 取消被误报成功的 bug):宏 = [goto 列表页] + list-detail
//   提取规则,详情页故意慢响应;提取阶段跑起来后 cancel()。
//   cancel() 靠关 context 让操作抛错冒泡的假设,会被 extractor 阶段二「单项失败不致命」的内层
//   catch 吞掉(它分不清"这页打不开"与"浏览器已被用户关掉"),于是剩余项被逐个吞成 default 行、
//   extract 正常返回。修复前:runner 不复查 cancelled → ok:true + 一份详情列全空的 rows →
//   后处理器照跑、导出半空 Excel 并弹窗。断言 {ok:false, cancelled:true} 且不带 rows。
//   注意本用例的宏**没有翻页步骤**,故 pagination 为 undefined、阶段二循环内那道 isCancelled
//   检查拿不到 —— 正好测的是 runner 层那道兜底检查。
//
// 用法:MACRO_HEADLESS=1 node scripts/verify-cancel.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const errorDir = path.join(root, 'errors');

let failed = 0;
const ok = (label) => console.log(`  ✅ ${label}`);
const bad = (label) => {
    console.log(`  ❌ ${label}`);
    failed += 1;
};

// ================= 用例 1:卡在慢步骤(waitForSelector)时停止 =================
console.log('\n========== 用例 1:卡在慢步骤时停止 ==========');
{
    // 造临时页面:只有一个占位元素,永远不会出现 #never
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-'));
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(
        page,
        `<!doctype html><meta charset="utf-8"><title>cancel-test</title>
<div id="host">页面已加载,但 #never 永不出现</div>`
    );

    const macro = {
        name: 'cancel-test',
        version: 1,
        steps: [
            { type: 'goto', url: pathToFileURL(page).href },
            // 等一个永不出现的元素,超时 30s;正常会一直卡到超时
            { type: 'waitForSelector', selector: '#never', timeout: 30000 },
        ],
    };

    const runner = new MacroRunner(errorDir);
    const cancelDelay = 800;
    setTimeout(() => {
        console.log(`\n>>> ${cancelDelay}ms 后调用 runner.cancel() 停止回放……\n`);
        runner.cancel();
    }, cancelDelay);

    const t0 = Date.now();
    const result = await runner.run(macro);
    const elapsed = Date.now() - t0;
    console.log('elapsed =', elapsed, 'ms  result =', JSON.stringify(result));

    // 断言:被打断(远小于 30s 超时,给足浏览器启动余量取 15s 上限)且标记为 cancelled
    if (elapsed < 15000) {
        ok('cancel() 立即打断了卡住的 waitForSelector');
    } else {
        bad(`停止不够及时:耗时 ${elapsed}ms(期望 <15000ms,说明未打断正在进行的操作)`);
    }
    if (result.cancelled === true && result.ok === false) {
        ok('返回 {ok:false, cancelled:true}(非失败)');
    } else {
        bad(`结果未标记为 cancelled:${JSON.stringify(result)}`);
    }
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* 清理失败不影响结论 */
    }
}

// ============ 用例 2:卡在 list-detail 提取阶段时停止(回归误报成功的 bug) ============
console.log('\n========== 用例 2:提取阶段停止不得误报成功 ==========');
{
    let detailHits = 0;
    const server = http.createServer(async (req, res) => {
        if (req.url === '/list') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            return res.end(`<!doctype html><meta charset="utf-8"><body>
<table id="list"><tbody>
  <tr data-id="A"><td><a class="d" href="/detail/a">A</a></td></tr>
  <tr data-id="B"><td><a class="d" href="/detail/b">B</a></td></tr>
  <tr data-id="C"><td><a class="d" href="/detail/c">C</a></td></tr>
</tbody></table></body>`);
        }
        if (req.url.startsWith('/detail/')) {
            detailHits += 1;
            // 详情页慢响应:留出在「提取阶段进行中」按下停止的时间窗
            await new Promise((r) => setTimeout(r, 2000));
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            return res.end(`<!doctype html><meta charset="utf-8"><body>
<div id="pin_form"><table>
  <thead><tr><th>#</th><th>Pin</th></tr></thead>
  <tbody><tr><td>1.</td><td>PIN-X</td></tr></tbody>
</table></div></body>`);
        }
        res.writeHead(404).end('not found');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const macro = {
        name: 'cancel-extract-test',
        version: 1,
        // 无翻页步骤 → pagination 为 undefined → 只能靠 runner 层那道 cancelled 复查兜底
        steps: [{ type: 'goto', url: `${base}/list` }],
        extract: {
            mode: 'list-detail',
            listSelector: '#list tbody tr[data-id]',
            fields: [
                { name: '订单ID', selector: '', type: 'attr', attr: 'data-id' },
                { name: '详情链接', selector: 'a.d', type: 'href', hidden: true },
            ],
            detailLinkField: '详情链接',
            detailListSelector: '#pin_form table tbody tr',
            detailFields: [{ name: 'Pin码', selector: 'td:nth-child(2)', type: 'text' }],
        },
    };

    const runner = new MacroRunner(errorDir);
    const cancelDelay = 3000; // 留足浏览器启动 + 列表页采集,确保停止落在阶段二(逐个进详情页)
    setTimeout(() => {
        console.log(`\n>>> ${cancelDelay}ms 后调用 runner.cancel()(此时应正在逐个进详情页)……\n`);
        runner.cancel();
    }, cancelDelay);

    const t0 = Date.now();
    const result = await runner.run(macro);
    const elapsed = Date.now() - t0;
    console.log('elapsed =', elapsed, 'ms  detailHits =', detailHits, ' result =', JSON.stringify(result));

    if (detailHits > 0) {
        ok(`停止确实落在提取阶段(详情页已被请求 ${detailHits} 次)`);
    } else {
        bad('停止发生在提取阶段之前,本用例没测到目标路径 —— 请调大 cancelDelay 或详情页延时');
    }
    if (result.cancelled === true && result.ok === false) {
        ok('提取阶段停止 → {ok:false, cancelled:true}(修复前会拿到 ok:true)');
    } else {
        bad(`提取阶段停止被误判:${JSON.stringify(result)}`);
    }
    if (result.rows === undefined) {
        ok('不回传半成品 rows(后处理器因此不会导出详情列全空的表)');
    } else {
        bad(`仍回传了 rows(${result.rows?.length} 行),会被导出成半空表格`);
    }
    server.close();
}

console.log('\n========== 汇总 ==========');
if (failed > 0) {
    console.log(`停止/中断自检未通过:${failed} 处失败。`);
    process.exit(1);
}
console.log('停止/中断自检全部通过。');
