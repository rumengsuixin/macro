// 临时验证:脆弱翻页选择器(第2页命中2个)+ 语义指纹通用重定位,应采满3页。
// 用法:MACRO_HEADLESS=1 node scripts/verify-pagination.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const macro = {
    name: 'quotes-pagination-test',
    version: 1,
    steps: [
        { type: 'goto', url: 'https://quotes.toscrape.com/page/1/' },
        {
            type: 'click',
            // 脆弱选择器:第1页只命中 Next(1 个),第2页起同时命中 Previous+Next(2 个)
            selector: '.pager li a',
            fingerprint: { tag: 'a', text: 'Next', anchor: 'li.next' },
            pagination: true,
            pageCount: 3,
        },
    ],
    extract: {
        mode: 'list',
        listSelector: '.quote',
        fields: [
            { name: 'text', selector: '.text', type: 'text' },
            { name: 'author', selector: '.author', type: 'text' },
        ],
    },
};

const runner = new MacroRunner(path.join(root, 'errors'));
const result = await runner.run(macro);

console.log('\n========== 验证结果 ==========');
console.log('ok =', result.ok);
if (result.ok) {
    console.log('提取行数 =', result.rows.length, '(期望 30)');
    console.log('首行 =', JSON.stringify(result.rows[0]));
    console.log('末行 =', JSON.stringify(result.rows[result.rows.length - 1]));
    process.exit(result.rows.length === 30 ? 0 : 2);
} else {
    console.log('错误 =', JSON.stringify(result.error, null, 2));
    process.exit(1);
}
