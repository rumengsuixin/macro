// 旁车上下文读写离线自检:验证 saveMacroCaptures/loadMacroCaptures 往返一致,
// 且「无上下文」时不留空壳旁车、并清掉旧旁车。不需网络/Electron;需先 npm run build。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(here, '..', 'dist', 'storage', 'macro-store.js');
if (!fs.existsSync(modPath)) {
    console.error('未找到 dist/storage/macro-store.js,请先运行 npm run build');
    process.exit(1);
}
const store = require(modPath);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-cap-'));
const macroPath = path.join(tmp, 'demo.json');
const sidecar = store.captureSidecarPath(macroPath);

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log('✅ ' + msg);
    } else {
        console.error('❌ ' + msg);
        failed += 1;
    }
}

const captures = {
    version: 1,
    steps: [
        null,
        {
            type: 'click',
            selector: '#_r_3_ > div.xwoeoq > button.x1lliihq',
            capture: {
                outerHTML: '<button aria-label="创建新账户">创建新账户</button>',
                ancestors: 'form#login_form class="xdqstbe"',
                contextHtml: '<form id="login_form"><button data-macro-cap="1" aria-label="创建新账户">创建新账户</button></form>',
            },
        },
    ],
};

async function main() {
    console.log('=== 旁车上下文读写自检 ===');
    console.log('旁车路径派生:', sidecar);
    assert(sidecar.endsWith('demo.captures.json'), '派生旁车名为 <宏名>.captures.json');

    // 1) 写入非空 captures → 旁车存在且往返一致
    await store.saveMacroCaptures(macroPath, captures);
    assert(fs.existsSync(sidecar), '非空 captures 写出旁车文件');
    const back = await store.loadMacroCaptures(macroPath);
    assert(back && JSON.stringify(back) === JSON.stringify(captures), '读回旁车与写入完全一致');
    assert(back.steps[0] === null && back.steps[1].capture.contextHtml.includes('data-macro-cap'), '空步骤为 null、标记随 contextHtml 保留');

    // 2) 空 captures → 删除旧旁车、不留空壳
    await store.saveMacroCaptures(macroPath, { version: 1, steps: [null, null] });
    assert(!fs.existsSync(sidecar), '空 captures 清掉旧旁车、不写空壳');
    const back2 = await store.loadMacroCaptures(macroPath);
    assert(back2 === null, '无旁车时 loadMacroCaptures 返回 null');

    // 3) undefined captures 亦安全(不抛)
    await store.saveMacroCaptures(macroPath, undefined);
    assert(!fs.existsSync(sidecar), 'undefined captures 不写文件、不抛');

    fs.rmSync(tmp, { recursive: true, force: true });
    if (failed > 0) {
        console.error(`\n自检未通过(${failed} 项)。`);
        process.exit(1);
    }
    console.log('\n自检通过:旁车读写往返一致、空则不留壳。');
}

main().catch((e) => {
    console.error('自检脚本异常:', e);
    process.exit(1);
});
