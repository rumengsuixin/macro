// 临时验证:点击触发新窗口后,下一步「等待元素出现」应跟随新窗口(不再卡旧页超时)。
// 造两个本地 html:page1 有一个 target=_blank 链接指向 page2;page2 在 1.5s 后才插入 #target。
// 宏 = [goto page1, click 链接(开新窗口), waitForSelector #target]。
// 修复前:第 3 步在旧页 page1 上等 #target → 超时失败;修复后:竞态跟随新窗口 → ok。
// 用法:MACRO_HEADLESS=1 node scripts/verify-popup-wait.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// 造临时页面
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-wait-'));
const page1 = path.join(dir, 'page1.html');
const page2 = path.join(dir, 'page2.html');
fs.writeFileSync(
    page1,
    `<!doctype html><meta charset="utf-8"><title>page1</title>
<a id="open" href="./page2.html" target="_blank">在新窗口打开</a>`
);
fs.writeFileSync(
    page2,
    `<!doctype html><meta charset="utf-8"><title>page2</title>
<div id="host">加载中……</div>
<script>
  // 1.5s 后才插入目标元素,模拟新窗口内容异步就绪
  setTimeout(function () {
    var t = document.createElement('div');
    t.id = 'target';
    t.textContent = '目标已就绪';
    document.body.appendChild(t);
  }, 1500);
</script>`
);

const macro = {
    name: 'popup-wait-test',
    version: 1,
    steps: [
        { type: 'goto', url: pathToFileURL(page1).href },
        { type: 'click', selector: '#open' }, // 打开新窗口(target=_blank)
        { type: 'waitForSelector', selector: '#target', timeout: 15000 }, // 目标在新窗口里
    ],
};

const runner = new MacroRunner(path.join(root, 'errors'));
const result = await runner.run(macro);

console.log('\n========== 验证结果 ==========');
console.log('ok =', result.ok);
if (result.ok) {
    console.log('第 3 步已跟随新窗口等到 #target(修复生效)。');
    process.exit(0);
} else {
    console.log('错误 =', JSON.stringify(result.error, null, 2));
    console.log('若为 waitForSelector 超时,说明未跟随新窗口(修复未生效)。');
    process.exit(1);
}
