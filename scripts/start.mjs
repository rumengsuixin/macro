// 跨平台启动脚本:以子进程方式拉起 Electron,并剥离 ELECTRON_RUN_AS_NODE。
//
// 某些环境(如 VSCode 扩展宿主、CI)会设置 ELECTRON_RUN_AS_NODE=1,
// 这会让 electron 退化为普通 Node 运行,导致 require('electron') 返回路径字符串、
// app 为 undefined。此脚本在子进程环境中删除该变量,保证 Electron 以应用方式启动。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 在普通 Node 下 require('electron') 返回 electron 可执行文件的路径
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env });

child.on('close', (code) => {
    process.exit(code ?? 0);
});
