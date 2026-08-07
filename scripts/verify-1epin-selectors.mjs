// 1epin 宏选择器离线自检:用**按归档源码结构复刻的合成页面**驱动编译后的 extract(),
// 直接吃 macros/1epin*.json 里的真实 extract 配置,断言 16 / 10 / 6 列都能取到正确值。
// 主要验证两件线上才暴露的事:① Playwright 的 :has() + :text-is() 标签定位语法确实可用;
// ② 列名 / 列序与 xlsxIntgration 参考产出一致。不联网、不碰真站。
// 需先 `npm run build`。用法:node scripts/verify-1epin-selectors.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extract } = require('../dist/core/extractor.js');
const { chromium } = require('playwright');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readMacro = (name) => JSON.parse(fs.readFileSync(path.join(repo, 'macros', name), 'utf-8'));

// ===== 合成页面:结构逐字对照归档 _EXTRACT_JS / _EXTRACT_PAYMENTS_JS / _EXTRACT_PINS_JS =====
// 订单行:td[1] 状态/下单/确认/单号/备注、td[2] 类别/产品、td[3] 数量/单价/金额/创建者、
//        td[4] 前后余额、td[5] 解锁(绿 7CFC00)/锁定(黄 FFD700);值取自参考文件真实行
const 标签 = (t) => `<strong class="alan-etiketi">${t}</strong>`;
const ORDERS_HTML = `<!doctype html><meta charset="utf-8"><body>
<table id="myTable"><tbody>
<tr data-id="1430658">
  <td>1</td>
  <td>
    <div>${标签('Sipariş Durumu:')}<span>Başarılı</span></div>
    <div>${标签('Sipariş Tarihi:')} 18 Mayıs 2026 19:05</div>
    <div>${标签('Onay Tarihi:')} 19 Mayıs 2026 00:54</div>
    <div>${标签('Sipariş No:')}<a href="/siparis/1430658">#1430645-nolu-islemden-kalan-18.05.2026 19:05:46</a></div>
    <div style="color:#3c9b49">400 adetli siparişin (#1430645) 200 adetine ait işlem</div>
  </td>
  <td>
    <div>${标签('Kategori:')} Google Play Hediye Kartı</div>
    <div>${标签('Ürün:')} Google play 50 TL</div>
  </td>
  <td>
    <div>${标签('Adet:')} 200</div>
    <div>${标签('Birim Fiyat:')}<span title="1.065 USD">1.07 USD</span></div>
    <div>${标签('Tutar:')}<span title="213.00 USD">213.00 USD</span></div>
    <div>${标签('Oluşturan:')} Sistem</div>
  </td>
  <td>
    <div>${标签('Önce:')}<span title="2875.1723556 USD">2875.17 USD</span></div>
    <div>${标签('Sonra:')}<span title="2023.1741123 USD">2023.17 USD</span></div>
  </td>
  <td><span style="color:#7CFC00">0</span> / <span style="color:#FFD700">200</span></td>
</tr>
<tr><td colspan="6">暂无记录</td></tr>
</tbody></table>
</body>`;

// 付款行:td[0] <strong>状态</strong><br>创建 / 确认;td[2] 金额 / <strong>用户</strong><br>(加密);
//        td[3] Önce/Sonra 两行。值取自参考文件真实行
const PAYMENTS_HTML = `<!doctype html><meta charset="utf-8"><body>
<table id="myTable"><tbody>
<tr data-id="961143">
  <td><strong>Başarılı</strong><br>22 Mayıs 2026 05:25 / 22 Mayıs 2026 05:25</td>
  <td>Bitcoin / Bitcoin-Trc20</td>
  <td><span class="woocommerce-Price-amount">3000,00 USD / <strong><i class="fa"></i>Kyle KK</strong><br>(3000,000USDT)</span></td>
  <td><span class="woocommerce-Price-amount">Önce: 106,60 USD<br>Sonra: 3106,60 USD</span></td>
</tr>
</tbody></table>
</body>`;

// Pin 详情页:#pin_form 里带 Pin 表头的表格,3 行明细
const PIN_DETAIL_HTML = `<!doctype html><meta charset="utf-8"><body>
<div id="pin_form"><table>
  <thead><tr><th>#</th><th>Seç</th><th>Pin</th><th>Görüntüleme</th></tr></thead>
  <tbody>
    <tr><td>1.</td><td><input type="checkbox" name="sec" value="5854010"></td><td>**********************</td><td></td></tr>
    <tr><td>2.</td><td><input type="checkbox" name="sec" value="5854011"></td><td>**********************</td><td>20 Mayıs 2026 10:00</td></tr>
    <tr><td>3.</td><td><input type="checkbox" name="sec" value="5854012"></td><td>PIN-VISIBLE-XYZ</td><td></td></tr>
  </tbody>
</table></div>
</body>`;

const server = http.createServer((req, res) => {
    const routes = {
        '/siparislerim': ORDERS_HTML,
        '/odemelerim': PAYMENTS_HTML,
        '/siparis/1430658': PIN_DETAIL_HTML,
    };
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

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
    // ===== 订单线 =====
    console.log('订单线:16 列标签定位');
    await page.goto(`${base}/siparislerim`, { waitUntil: 'domcontentloaded' });
    const orderRows = await extract(page, readMacro('1epin.json').extract);
    assertEq('只采到带 data-id 的真实行(「暂无记录」占位行被排除)', orderRows.length, 1);
    assertEq('16 列全部命中,值与参考文件一致', orderRows[0], {
        订单ID: '1430658',
        订单状态: 'Başarılı',
        下单时间: '2026-05-18 19:05',
        确认时间: '2026-05-19 00:54',
        订单号: '1430645-nolu-islemden-kalan-18.05.2026 19:05:46',
        备注: '400 adetli siparişin (#1430645) 200 adetine ait işlem',
        类别: 'Google Play Hediye Kartı',
        产品: 'Google play 50 TL',
        数量: '200',
        '单价(USD)': '1.065',
        '金额(USD)': '213.00',
        创建者: 'Sistem',
        '交易前余额(USD)': '2875.1723556',
        '交易后余额(USD)': '2023.1741123',
        已解锁数量: '0',
        已锁定数量: '200',
    });
    assertEq(
        '列序与参考文件 epin_siparisler 一致',
        Object.keys(orderRows[0]),
        ['订单ID', '订单状态', '下单时间', '确认时间', '订单号', '备注', '类别', '产品', '数量',
         '单价(USD)', '金额(USD)', '创建者', '交易前余额(USD)', '交易后余额(USD)', '已解锁数量', '已锁定数量']
    );
    assertEq('金额取 span[title] 而非页面显示值(显示值被站点截短)', orderRows[0]['单价(USD)'], '1.065');

    // ===== 付款线 =====
    console.log('付款线:10 列节点游走');
    await page.goto(`${base}/odemelerim`, { waitUntil: 'domcontentloaded' });
    const payRows = await extract(page, readMacro('1epin-payments.json').extract);
    assertEq('10 列全部命中,值与参考文件一致', payRows[0], {
        付款ID: '961143',
        付款状态: 'Başarılı',
        创建时间: '2026-05-22 05:25',
        确认时间: '2026-05-22 05:25',
        付款类型: 'Bitcoin / Bitcoin-Trc20',
        '付款金额(USD)': '3000,00',
        用户: 'Kyle KK',
        加密货币金额: '3000,000USDT',
        '付款前余额(USD)': '106,60',
        '付款后余额(USD)': '3106,60',
    });
    assertEq(
        '列序与参考文件 epin_odemeler 一致',
        Object.keys(payRows[0]),
        ['付款ID', '付款状态', '创建时间', '确认时间', '付款类型', '付款金额(USD)', '用户',
         '加密货币金额', '付款前余额(USD)', '付款后余额(USD)']
    );

    // ===== Pin 线 =====
    console.log('Pin 线:进详情页按明细行展开');
    await page.goto(`${base}/siparislerim`, { waitUntil: 'domcontentloaded' });
    const pinRows = await extract(page, readMacro('1epin-pins.json').extract);
    assertEq('一个订单的 3 条明细各出一行', pinRows.length, 3);
    assertEq('订单ID / 订单号在三行里重复', [...new Set(pinRows.map((r) => `${r['订单ID']}|${r['订单号']}`))], [
        '1430658|1430645-nolu-islemden-kalan-18.05.2026 19:05:46',
    ]);
    assertEq(
        '序号 / Pin ID / Pin码 逐行取到各自的值',
        pinRows.map((r) => `${r['序号']}/${r['Pin ID']}/${r['Pin码']}`),
        ['1/5854010/**********************', '2/5854011/**********************', '3/5854012/PIN-VISIBLE-XYZ']
    );
    // 查看时间同样走日期归一(依归档**文档**的清洗规则表;归档代码 _save_pins_excel 实际漏做,此处按文档)
    assertEq('查看时间:缺失留空、有值归一为 YYYY-MM-DD HH:MM', pinRows.map((r) => r['查看时间']), [
        '', '2026-05-20 10:00', '',
    ]);
    assertEq(
        '导出列序与参考文件 epin_pinler 一致(详情链接为隐藏列)',
        Object.keys(pinRows[0]).filter((k) => k !== '详情链接'),
        ['订单ID', '订单号', '序号', 'Pin ID', 'Pin码', '查看时间']
    );
} finally {
    await browser.close();
    server.close();
}

if (failed > 0) {
    console.error(`\n1epin 选择器自检失败:${failed} 项。`);
    process.exit(1);
}
console.log('\n1epin 选择器自检全部通过。');
