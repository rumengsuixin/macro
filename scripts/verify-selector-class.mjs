// 选择器稳定类判定离线自检:断言 isStableClass 能过滤 Facebook Stylex / Twitter 原子类,
// 同时不误伤真实语义类(尤其 next/previous,关乎既有翻页选择器)。
// 需先 `npm run build`(编译出 dist/core/selector-generator.js,CommonJS)。
// 用法:node scripts/verify-selector-class.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isStableClass } = require('../dist/core/selector-generator.js');

if (typeof isStableClass !== 'function') {
    console.error('未导出 isStableClass,请确认已 npm run build');
    process.exit(1);
}

// 应判为「不稳定」(过滤掉)的原子/哈希类
const dynamic = [
    // Facebook Stylex
    'x1ey2m1c', 'x78zum5', 'xdt5ytf', 'x156j7k', 'x1miatn0', 'x1gan7if',
    'x13vifvy', 'xxo9b9y', 'x1n2onr6', 'x1ja2u2z', 'x9f619', 'x193iq5w',
    // Twitter/X
    'r-1xnzce8', 'r-1awozwy',
];

// 应判为「稳定」(保留)的真实语义类
const stable = [
    'header', 'active', 'btn-primary', 'col-md-6', 'nav-item',
    'x-axis', 'row', 'next', 'previous',
];

let failed = 0;
for (const cls of dynamic) {
    if (isStableClass(cls) !== false) {
        console.error(`  [失败] 原子类未被过滤: ${cls}`);
        failed += 1;
    }
}
for (const cls of stable) {
    if (isStableClass(cls) !== true) {
        console.error(`  [失败] 语义类被误伤: ${cls}`);
        failed += 1;
    }
}

if (failed > 0) {
    console.error(`\n自检失败:共 ${failed} 处不符合预期`);
    process.exit(1);
}
console.log(`自检通过:过滤 ${dynamic.length} 个原子类、保留 ${stable.length} 个语义类,均符合预期`);
