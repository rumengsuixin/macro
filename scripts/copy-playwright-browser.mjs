// 把与当前 playwright 版本匹配的 Chromium 下载到 build/ms-playwright,
// 供 electron-builder 的 extraResources 打进安装包(目标机无需装 playwright)。
//
// 健壮性设计:
// - 平台校验:playwright 只下载“当前系统”的浏览器,故打 Windows 包必须在 Windows 上跑,
//   否则会装成别的平台、产出坏包 → 直接报错退出。
// - 用项目本地 playwright 的 cli.js(不走 npx,避免无 node_modules 时联网拉最新版导致版本错配),
//   下载的 Chromium 版本与运行时 playwright 必然一致。
// - 下载前清空目标目录:避免升级 playwright 后旧版本浏览器残留、一起被打进包。
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

// 1) 平台校验:本项目打 Windows NSIS 包,必须在 Windows 上打包
if (process.platform !== 'win32') {
    console.error(
        `[打包浏览器] 错误:当前系统是 ${process.platform},但本项目打的是 Windows 安装包。\n` +
            '            playwright 只会下载当前系统的浏览器,请在 Windows 机器上运行打包。'
    );
    process.exit(1);
}

// 2) 定位项目本地 playwright 的 cli.js(版本与运行时一致);未安装则提示先 npm install
let cliPath;
let pwVersion;
try {
    const pkgJson = require.resolve('playwright/package.json');
    cliPath = path.join(path.dirname(pkgJson), 'cli.js');
    pwVersion = require('playwright/package.json').version;
    if (!fs.existsSync(cliPath)) throw new Error('cli.js 缺失');
} catch {
    console.error('[打包浏览器] 错误:未找到本地 playwright,请先运行 npm install。');
    process.exit(1);
}

// 3) 清空目标目录,保证只含当前版本浏览器
const dest = path.resolve('build', 'ms-playwright');
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

// 4) 用本地 playwright 下载 Chromium 到指定目录(自带 ffmpeg 等依赖)
console.log(`[打包浏览器] 用本地 playwright ${pwVersion} 下载 Chromium 到 ${dest} ...`);
try {
    execFileSync(process.execPath, [cliPath, 'install', 'chromium'], {
        stdio: 'inherit',
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dest },
    });
} catch (err) {
    console.error(
        '[打包浏览器] 下载失败(可能无网络或被防火墙拦截)。请联网后重试。原始错误:',
        err.message
    );
    process.exit(1);
}

// 5) 校验产物:确认 Windows Chromium 主程序确实就位
const chromeExe = fs
    .readdirSync(dest)
    .filter((d) => d.startsWith('chromium-'))
    .map((d) => path.join(dest, d, 'chrome-win64', 'chrome.exe'))
    .find((p) => fs.existsSync(p));
if (!chromeExe) {
    console.error('[打包浏览器] 错误:下载完成但未找到 chrome.exe,产物异常,终止。');
    process.exit(1);
}
console.log(`[打包浏览器] 完成,已就位:${chromeExe}`);
