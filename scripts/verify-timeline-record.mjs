// 录制端「只记录不修改」支路端到端自检的启动器:剥离 ELECTRON_RUN_AS_NODE,以「应用方式」
// 拉起 Electron 跑 scripts/_timeline-record-e2e.cjs(真跑 CDP Network 记录链路)。需先 `npm run build`。
// 用法:node scripts/verify-timeline-record.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const here = path.dirname(fileURLToPath(import.meta.url));
const mainScript = path.join(here, '_timeline-record-e2e.cjs');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [mainScript], { stdio: 'inherit', env });

// 兜底超时:比子进程内部 15s 略长,防子进程本身卡死
const killer = setTimeout(() => {
    console.error('启动器超时,强制结束 Electron 子进程。');
    child.kill('SIGKILL');
    process.exit(1);
}, 25000);

child.on('close', (code) => {
    clearTimeout(killer);
    process.exit(code ?? 0);
});
