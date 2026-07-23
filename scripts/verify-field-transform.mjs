// 离线自检:验证「字段清洗管道」(块四)。不需网络。
// 覆盖:
//   ① transform 链:trim / collapseWhitespace / replace / stripThousands / number / date
//   ② 兼容旧行为:无 transform 时 text 仍 trim、其它类型原样(证明零回归)
//   ③ default:清洗后为空则填默认值
//   ④ fieldsToColumnSpecs:label 重命名 / order 排序 / hidden 隐藏 / number·date 推导 numFmt+kind
//   ⑤ exportToExcel 带列规格:读回断言表头用 label、按 order 排、hidden 不出列、数字/日期为真类型
//   ⑥ exportToExcel 不带列规格:退回历史行为(行 key 并集、列名=key)
// 用法:npm run build && node scripts/verify-field-transform.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
const { cleanFieldValue, fieldsToColumnSpecs } = require('../dist/core/field-transform.js');
const { exportToExcel } = require('../dist/core/excel-exporter.js');

const tmpRoot = path.join(os.tmpdir(), `macro-fieldtransform-verify-${process.pid}`);
mkdirSync(tmpRoot, { recursive: true });

let failed = false;
function check(cond, label) {
    console.log(`${cond ? '✅' : '❌'} ${label}`);
    if (!cond) failed = true;
}

// ---------- ① transform 链 ----------
const trimField = { name: 'a', selector: '', type: 'html', transform: [{ op: 'trim' }] };
check(cleanFieldValue(trimField, '  hi  ') === 'hi', 'trim 去首尾空白');

const collapseField = { name: 'a', selector: '', type: 'html', transform: [{ op: 'collapseWhitespace' }] };
check(cleanFieldValue(collapseField, ' x \n\t y  ') === 'x y', 'collapseWhitespace 折叠空白');

const replaceField = {
    name: 'a', selector: '', type: 'html',
    transform: [{ op: 'replace', pattern: '\\s*元$', flags: '', to: '' }],
};
check(cleanFieldValue(replaceField, '3.5 元') === '3.5', 'replace 正则替换');

const badRegexField = {
    name: 'a', selector: '', type: 'html',
    transform: [{ op: 'replace', pattern: '(', flags: '', to: '' }, { op: 'trim' }],
};
check(cleanFieldValue(badRegexField, '  keep  ') === 'keep', '非法正则跳过该步、后续步仍生效');

const thousandsField = { name: 'a', selector: '', type: 'html', transform: [{ op: 'stripThousands' }] };
check(cleanFieldValue(thousandsField, '1,234,567') === '1234567', 'stripThousands 剥千分位');

const numberField = {
    name: 'a', selector: '', type: 'html',
    transform: [{ op: 'replace', pattern: '[^0-9.,]', flags: 'g', to: '' }, { op: 'stripThousands' }, { op: 'number', decimals: 2 }],
};
check(cleanFieldValue(numberField, '¥1,234.5') === '1234.50', 'number 规整为两位小数');

const numberNaNField = { name: 'a', selector: '', type: 'html', transform: [{ op: 'number' }] };
check(cleanFieldValue(numberNaNField, 'abc') === 'abc', 'number 遇非数字保持原值(不猜)');

const dateField = { name: 'a', selector: '', type: 'html', transform: [{ op: 'date', to: 'YYYY-MM-DD' }] };
check(cleanFieldValue(dateField, '2026-07-23 15:30:00') === '2026-07-23', 'date 格式化为 YYYY-MM-DD');
check(cleanFieldValue(dateField, 'not-a-date') === 'not-a-date', 'date 遇非法日期保持原值');

// ---------- ② 兼容旧行为 ----------
check(cleanFieldValue({ name: 'a', selector: '', type: 'text' }, '  hi \n ') === 'hi', '无 transform 时 text 仍 trim');
check(cleanFieldValue({ name: 'a', selector: '', type: 'html' }, '  <b> ') === '  <b> ', '无 transform 时 html 原样(零回归)');

// ---------- ③ default ----------
check(cleanFieldValue({ name: 'a', selector: '', type: 'text', default: 'N/A' }, '') === 'N/A', '空值套 default');
check(cleanFieldValue({ name: 'a', selector: '', type: 'text' }, '') === '', '无 default 时空值仍为空串');

// ---------- ④ fieldsToColumnSpecs ----------
const fields = [
    { name: 'amt', selector: '', type: 'text', label: '金额', order: 2, transform: [{ op: 'number', decimals: 2 }] },
    { name: 'day', selector: '', type: 'text', label: '日期', order: 1, transform: [{ op: 'date', to: 'YYYY-MM-DD' }] },
    { name: 'secret', selector: '', type: 'text', hidden: true },
];
const specs = fieldsToColumnSpecs(fields);
const amtSpec = specs.find((s) => s.key === 'amt');
const daySpec = specs.find((s) => s.key === 'day');
const secretSpec = specs.find((s) => s.key === 'secret');
check(amtSpec.label === '金额' && amtSpec.kind === 'number' && amtSpec.numFmt === '0.00', 'amt 列:label/number/numFmt');
check(daySpec.label === '日期' && daySpec.kind === 'date' && daySpec.numFmt === 'yyyy-mm-dd', 'day 列:label/date/numFmt');
check(secretSpec.hidden === true, 'secret 列标记 hidden');
check(amtSpec.order === 2 && daySpec.order === 1, 'order 保留字段声明值');

// ---------- ⑤ exportToExcel 带列规格 ----------
const rows = [
    { amt: '1234.50', day: '2026-07-23', secret: 'x' },
    { amt: '9.00', day: '2026-01-05', secret: 'y' },
];
const outWithCols = path.join(tmpRoot, 'with-cols.xlsx');
await exportToExcel(rows, outWithCols, specs);
{
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outWithCols);
    const sheet = wb.getWorksheet('数据');
    const header = sheet.getRow(1);
    // hidden 剔除后剩两列,按 order 升序:日期(order1) 在前、金额(order2) 在后
    check(header.getCell(1).value === '日期' && header.getCell(2).value === '金额', '表头用 label 且按 order 排');
    check(sheet.columnCount === 2, 'hidden 列不出表(secret 被剔除)');
    const dataRow = sheet.getRow(2);
    check(typeof dataRow.getCell(2).value === 'number' && dataRow.getCell(2).value === 1234.5, '数字列写真 number 类型');
    check(dataRow.getCell(1).value instanceof Date, '日期列写真 Date 类型');
    check(dataRow.getCell(2).numFmt === '0.00', '数字单元格带 numFmt 0.00');
    check(dataRow.getCell(1).numFmt === 'yyyy-mm-dd', '日期单元格带 numFmt yyyy-mm-dd');
}

// ---------- ⑥ exportToExcel 不带列规格(历史行为) ----------
const outNoCols = path.join(tmpRoot, 'no-cols.xlsx');
await exportToExcel(rows, outNoCols);
{
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outNoCols);
    const sheet = wb.getWorksheet('数据');
    const header = sheet.getRow(1);
    check(header.getCell(1).value === 'amt' && header.getCell(3).value === 'secret', '无列规格:列名=key、含全部列(含 secret)');
    check(sheet.columnCount === 3, '无列规格:行 key 并集 3 列');
}

rmSync(tmpRoot, { recursive: true, force: true });
console.log(failed ? '\n❌ 有用例未通过' : '\n✅ 字段清洗自检全部通过');
process.exit(failed ? 1 : 0);
