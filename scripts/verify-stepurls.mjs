import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// 造一个跨页宏:先到 quotes 首页,点某作者链接进入 /author/... 详情页
const macro = {
    name: 'stepurls-probe',
    version: 1,
    steps: [
        { type: 'goto', url: 'https://quotes.toscrape.com/' },
        { type: 'click', selector: 'a[href="/author/Albert-Einstein"]' },
        { type: 'waitForSelector', selector: '.author-title' },
    ],
};
const runner = new MacroRunner(path.join(root, 'errors'));
const result = await runner.run(macro);
console.log('ok =', result.ok, 'cancelled =', result.cancelled);
console.log('stepUrls =', JSON.stringify(result.stepUrls, null, 0));
// 断言:第1步(click)来源应是首页,第2步(wait)来源应是详情页(点链接跳转、无 goto)
const u = result.stepUrls || [];
const okClickSrc = /quotes\.toscrape\.com\/?$/.test(u[1] || '');
const okWaitSrc = /\/author\//.test(u[2] || '');
console.log('第2步click来源=首页?', okClickSrc, '| 第3步wait来源=详情页?', okWaitSrc);
console.log(okClickSrc && okWaitSrc ? '✅ 回填数据正确捕获了链接跳转后的新页面 URL' : '❌ 未按预期捕获');
process.exit(0);
