// 临时验证脚本:直接用编译后的 core 跑一遍 demo 宏,验证「回放→提取→导出 Excel」管道。
// 用法:MACRO_HEADLESS=1 node scripts/verify-core.mjs
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const { exportToExcel } = require('../dist/core/excel-exporter.js');

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const macro = JSON.parse(readFileSync(path.join(root, 'examples', 'demo-macro.json'), 'utf-8'));

mkdirSync(path.join(root, 'exports'), { recursive: true });

const runner = new MacroRunner(path.join(root, 'errors'));
const result = await runner.run(macro);

console.log('\n========== 验证结果 ==========');
console.log('ok =', result.ok);
if (result.ok) {
    console.log('提取行数 =', result.rows.length);
    console.log('前两行 =', JSON.stringify(result.rows.slice(0, 2), null, 2));
    const out = path.join(root, 'exports', 'verify-result.xlsx');
    await exportToExcel(result.rows, out);
    console.log('已导出 Excel =', out);
} else {
    console.log('错误 =', JSON.stringify(result.error, null, 2));
    process.exit(1);
}
