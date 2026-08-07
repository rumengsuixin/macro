// 1epin 三个宏的字段清洗链离线自检:**直接读 macros/1epin*.json 里的真实字段定义**,
// 喂入页面上会出现的原始取值,断言清洗结果与归档 Python(_parse_tr_date / v.split()[0] / 节点游走)一致。
// 不起浏览器、不联网。改了宏里的 transform 就跑它。
// 需先 `npm run build`。用法:node scripts/verify-1epin-transform.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cleanFieldValue } = require('../dist/core/field-transform.js');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readMacro = (name) => JSON.parse(fs.readFileSync(path.join(repo, 'macros', name), 'utf-8'));
const orders = readMacro('1epin.json');
const payments = readMacro('1epin-payments.json');
const pins = readMacro('1epin-pins.json');

/** 从宏的提取规则里按字段名取出真实字段定义(找不到直接判失败,防止宏改名后自检空转) */
function fieldOf(macro, name, group = 'fields') {
    const f = (macro.extract[group] ?? []).find((x) => x.name === name);
    if (!f) {
        throw new Error(`宏「${macro.name}」的 ${group} 里没有字段「${name}」`);
    }
    return f;
}

let failed = 0;
function check(label, field, raw, expected) {
    const actual = cleanFieldValue(field, raw);
    if (actual === expected) {
        console.log(`  [通过] ${label}`);
    } else {
        console.error(`  [失败] ${label}\n         原始=${JSON.stringify(raw)}\n         实际=${JSON.stringify(actual)}\n         期望=${JSON.stringify(expected)}`);
        failed += 1;
    }
}

console.log('订单线:标签剥离 + 土耳其日期归一 + 金额剥币种');
const 下单时间 = fieldOf(orders, '下单时间');
check('两位日 18 Mayıs 2026 19:05', 下单时间, 'Sipariş Tarihi: 18 Mayıs 2026 19:05', '2026-05-18 19:05');
check('一位日补零 8 Mart 2026 09:05', 下单时间, 'Sipariş Tarihi: 8 Mart 2026 09:05', '2026-03-08 09:05');
check('12 月名全覆盖 Aralık', 下单时间, 'Sipariş Tarihi: 31 Aralık 2026 23:59', '2026-12-31 23:59');
check('Şubat/Ağustos/Eylül/Kasım 变音字符', 下单时间, 'Sipariş Tarihi: 01 Ağustos 2026 00:01', '2026-08-01 00:01');
check('只有日期没有时间', 下单时间, 'Sipariş Tarihi: 18 Mayıs 2026', '2026-05-18');
check('多余空白折叠', 下单时间, 'Sipariş Tarihi:\n   18   Mayıs   2026 19:05  ', '2026-05-18 19:05');
check('空值原样为空', 下单时间, '', '');
check('无法识别的日期原样返回(不猜)', 下单时间, 'Sipariş Tarihi: 待定', '待定');

const 确认时间 = fieldOf(orders, '确认时间');
check('确认时间独立剥自己的标签', 确认时间, 'Onay Tarihi: 19 Mayıs 2026 00:54', '2026-05-19 00:54');

const 订单号 = fieldOf(orders, '订单号');
check('订单号去前导 #(参考文件真实值)', 订单号, '#1430645-nolu-islemden-kalan-18.05.2026 19:05:46', '1430645-nolu-islemden-kalan-18.05.2026 19:05:46');
check('订单号本就无 # 时不动', 订单号, '0d2187878d1c4fe9a7414e4b157cfda1', '0d2187878d1c4fe9a7414e4b157cfda1');

const 单价 = fieldOf(orders, '单价(USD)');
check('剥币种 1.065 USD', 单价, '1.065 USD', '1.065');
check('无币种后缀时原样', 单价, '213.00', '213.00');
check('高精度余额不被截断(铁律)', fieldOf(orders, '交易前余额(USD)'), '2875.1723556 USD', '2875.1723556');
check('title 前有空白也不误伤', fieldOf(orders, '金额(USD)'), '  426.00 USD ', '426.00');

const 类别 = fieldOf(orders, '类别');
check('类别剥标签', 类别, 'Kategori: Google Play Hediye Kartı', 'Google Play Hediye Kartı');
check('产品剥标签', fieldOf(orders, '产品'), 'Ürün: Google play 50 TL', 'Google play 50 TL');
check('创建者剥标签', fieldOf(orders, '创建者'), 'Oluşturan: Kyle KK', 'Kyle KK');
check('数量剥标签', fieldOf(orders, '数量'), 'Adet: 200', '200');

console.log('付款线:按节点位置游走的正则切分');
// td[0] 结构:<strong>状态</strong><br>创建时间 / 确认时间  → innerText 首行是状态
const 付款创建 = fieldOf(payments, '创建时间');
const 付款确认 = fieldOf(payments, '确认时间');
const TD0 = 'Başarılı\n22 Mayıs 2026 05:25 / 23 Mayıs 2026 06:30';
check('创建时间取斜杠前', 付款创建, TD0, '2026-05-22 05:25');
check('确认时间取斜杠后', 付款确认, TD0, '2026-05-23 06:30');
const TD0_NO_SLASH = 'Beklemede\n22 Mayıs 2026 05:25';
check('无斜杠时创建时间仍取到', 付款创建, TD0_NO_SLASH, '2026-05-22 05:25');
check('无斜杠时确认时间为空(不误抄创建时间)', 付款确认, TD0_NO_SLASH, '');

// td[2] span 结构:金额 币种 / <strong>用户</strong><br>(加密货币金额)
const 付款金额 = fieldOf(payments, '付款金额(USD)');
const 加密金额 = fieldOf(payments, '加密货币金额');
const SPAN2 = '3000,00 USD / Kyle KK\n(3000,000USDT)';
check('付款金额截到斜杠前并剥币种(逗号小数保真)', 付款金额, SPAN2, '3000,00');
check('加密货币金额取括号内', 加密金额, SPAN2, '3000,000USDT');
check('中文全角括号也吃', 加密金额, '3000,00 USD / Kyle KK\n（3000,000USDT）', '3000,000USDT');
check('无用户名结构:金额仍取对', 付款金额, '6000,00 USD\n(6000,000USDT)', '6000,00');
check('没有括号时加密金额为空(不误抄金额)', 加密金额, '3000,00 USD / Kyle KK', '');

// td[3] span 结构:Önce: 前余额<br>Sonra: 后余额
const 前余额 = fieldOf(payments, '付款前余额(USD)');
const 后余额 = fieldOf(payments, '付款后余额(USD)');
const SPAN3 = 'Önce: 106,60 USD\nSonra: 3106,60 USD';
check('付款前余额取首行冒号后', 前余额, SPAN3, '106,60');
check('付款后余额取次行冒号后', 后余额, SPAN3, '3106,60');
check('全角冒号也吃', 前余额, 'Önce：106,60 USD\nSonra：3106,60 USD', '106,60');
check('只有一行时后余额为空(不误抄前余额)', 后余额, 'Önce: 106,60 USD', '');

console.log('Pin 线:详情页明细字段');
check('序号去尾点', fieldOf(pins, '序号', 'detailFields'), '1.', '1');
check('序号本就无尾点时不动', fieldOf(pins, '序号', 'detailFields'), '12', '12');
check('Pin 码遮蔽值原样保留', fieldOf(pins, 'Pin码', 'detailFields'), '**********************', '**********************');
check('Pin 线订单号同样去 #', fieldOf(pins, '订单号'), '#1430658', '1430658');

if (failed > 0) {
    console.error(`\n1epin 清洗链自检失败:${failed} 项。`);
    process.exit(1);
}
console.log('\n1epin 清洗链自检全部通过。');
