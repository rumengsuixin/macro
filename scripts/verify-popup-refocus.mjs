// 临时验证:P0 活动页关闭回切。点击用 window.open 打开新标签(弹窗),弹窗 800ms 后 window.close() 自关。
// 修复前:焦点悬在已关弹窗 → 下一步 waitForSelector 在死页执行 → Target closed → ok=false。
// 修复后:弹窗关闭触发回切到栈顶存活页(page1)→ waitForSelector #p1-marker 命中 → ok=true。
// 断言:日志含「检测到新标签页弹窗…」(曾切到弹窗)+「活动页已关闭,已回切…」(回切),且 result.ok。
// 用法:MACRO_HEADLESS=1 node scripts/verify-popup-refocus.mjs
//   本机缺 headless chromium 时前置 PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const SWITCH = '检测到新标签页弹窗,已切换为活动页继续回放。';
const REFOCUS = '活动页已关闭,已回切到上一个存活页继续回放。';

// 捕获 runner 中文日志(logInfo → console.log),供回切断言
const logLines = [];
const origLog = console.log;
console.log = (...a) => {
    logLines.push(a.map(String).join(' '));
    origLog(...a);
};

// 造临时页:page1 有恒存元素 #p1-marker + 一个用 window.open 开 page2 的按钮;page2 自关。
// 必须 window.open 开窗(而非 target=_blank 链接),否则弹窗页无法被脚本 window.close()。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-refocus-'));
const page1 = path.join(dir, 'page1.html');
const page2 = path.join(dir, 'page2.html');
fs.writeFileSync(
    page1,
    `<!doctype html><meta charset="utf-8"><title>page1</title>
<div id="p1-marker">page1 恒存元素</div>
<button id="open" onclick="window.open('./page2.html')">开新标签</button>`
);
fs.writeFileSync(
    page2,
    `<!doctype html><meta charset="utf-8"><title>page2</title>
<div id="host">弹窗页,即将自关</div>
<script>
  // 800ms 后自关(window.open 打开的窗口可被脚本关闭)
  setTimeout(function () { window.close(); }, 800);
</script>`
);

// onPause:保活直到看到回切日志(或 12s 兜底),给「弹窗打开→自关→回切」留出时序
const onPause = () =>
    new Promise((resolve) => {
        const deadline = Date.now() + 12000;
        const iv = setInterval(() => {
            if (logLines.some((l) => l.includes(REFOCUS)) || Date.now() > deadline) {
                clearInterval(iv);
                resolve();
            }
        }, 100);
    });

fs.mkdirSync(path.join(root, 'errors'), { recursive: true });

const macro = {
    name: 'popup-refocus-test',
    version: 1,
    steps: [
        { type: 'goto', url: pathToFileURL(page1).href },
        { type: 'click', selector: '#open' }, // window.open 开弹窗
        { type: 'pause' }, // 保活等弹窗自关 + 回切
        { type: 'waitForSelector', selector: '#p1-marker', timeout: 8000 }, // 须在回切后的 page1 上命中
    ],
};

const runner = new MacroRunner(path.join(root, 'errors'), undefined, onPause);

let result;
try {
    result = await Promise.race([
        runner.run(macro),
        new Promise((_, reject) => setTimeout(() => reject(new Error('自检硬超时(30s)')), 30000)),
    ]);
} catch (err) {
    console.log = origLog;
    console.log('❌ 回放异常:', err.message);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
}

console.log = origLog; // 还原,后续断言输出不再入 logLines

let failed = 0;
const assert = (cond, msg) => {
    if (cond) {
        console.log('  ✅ ' + msg);
    } else {
        console.log('  ❌ ' + msg);
        failed += 1;
    }
};

console.log('\n========== 验证结果 ==========');
assert(
    logLines.some((l) => l.includes(SWITCH)),
    '曾切到新标签弹窗(有切换日志)'
);
assert(
    logLines.some((l) => l.includes(REFOCUS)),
    '弹窗关闭后回切到存活页(有回切日志)'
);
assert(
    result && result.ok === true,
    'result.ok === true(回切后 waitForSelector #p1-marker 命中)'
);
if (!(result && result.ok)) {
    console.log('  错误 =', JSON.stringify(result && result.error, null, 2));
}

fs.rmSync(dir, { recursive: true, force: true });

if (failed === 0) {
    console.log('\n✅ P0 活动页关闭回切:通过。');
    process.exit(0);
} else {
    console.log(`\n❌ 失败 ${failed} 项。`);
    process.exit(1);
}
