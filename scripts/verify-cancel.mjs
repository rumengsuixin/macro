// 停止/中断回放离线自检:验证 MacroRunner.cancel() 能立即打断卡在慢步骤上的回放。
// 造一个本地页面(无 #never 元素),宏 = [goto, waitForSelector #never timeout 30s]。
// 正常会卡 30 秒才超时失败;本自检在 run() 期间 800ms 后调 runner.cancel(),
// 断言:①回放在远早于 30s 内返回(证明确实被打断);②result.cancelled===true(非失败)。
// 用法:MACRO_HEADLESS=1 node scripts/verify-cancel.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

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

const runner = new MacroRunner(path.join(root, 'errors'));

// 800ms 后主动请求停止(此时应正卡在第 2 步 waitForSelector 上)
const cancelDelay = 800;
setTimeout(() => {
    console.log(`\n>>> ${cancelDelay}ms 后调用 runner.cancel() 停止回放……\n`);
    runner.cancel();
}, cancelDelay);

const t0 = Date.now();
const result = await runner.run(macro);
const elapsed = Date.now() - t0;

console.log('\n========== 验证结果 ==========');
console.log('elapsed =', elapsed, 'ms');
console.log('result =', JSON.stringify(result));

// 断言:被打断(远小于 30s 超时,给足浏览器启动余量取 15s 上限)且标记为 cancelled
const stoppedFast = elapsed < 15000;
const isCancelled = result.cancelled === true && result.ok === false;

if (stoppedFast && isCancelled) {
    console.log('✅ cancel() 立即打断了卡住的 waitForSelector,且返回 cancelled=true(非失败)。');
    process.exit(0);
} else {
    if (!stoppedFast) {
        console.log(`❌ 停止不够及时:耗时 ${elapsed}ms(期望 <15000ms,说明未打断正在进行的操作)。`);
    }
    if (!isCancelled) {
        console.log('❌ 结果未标记为 cancelled(期望 {ok:false, cancelled:true})。');
    }
    process.exit(1);
}
