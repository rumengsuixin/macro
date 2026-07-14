// 把与当前 playwright 版本匹配的 Chromium 下载到 build/ms-playwright,
// 供 electron-builder 的 extraResources 打进安装包(目标机无需装 playwright)。
//
// 健壮性设计:
// - 平台校验:playwright 只下载“当前系统”的浏览器,故打 Windows 包必须在 Windows 上跑,
//   否则会装成别的平台、产出坏包 → 直接报错退出。
// - 用项目本地 playwright 的 cli.js(不走 npx,避免无 node_modules 时联网拉最新版导致版本错配),
//   下载的 Chromium 版本与运行时 playwright 必然一致。
// - 缓存复用(幂等):用 build/ms-playwright/.pw-version 标记已下载的版本。
//   版本未变且 chrome.exe 在位 → 直接跳过下载,复用上次结果(多次打包 0 下载)。
//   仅首次打包或升级 playwright 后,才清空目录并重新下载,避免旧版本浏览器残留被打进包。
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

// 1) 平台校验:playwright 只下载“当前系统”的浏览器,故必须在目标 OS 上打包。
//    本项目支持 Windows(NSIS)与 macOS(dmg/zip);其它平台不支持。
if (process.platform !== 'win32' && process.platform !== 'darwin') {
    console.error(
        `[打包浏览器] 错误:当前系统是 ${process.platform},本项目仅支持在 Windows 或 macOS 上打包。\n` +
            '            playwright 只会下载当前系统的浏览器,请在 Windows 或 macOS 机器上运行打包。'
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

const dest = path.resolve('build', 'ms-playwright');
const versionMark = path.join(dest, '.pw-version');

// 当前平台 chromium-* 目录下的主程序相对路径(win 与 mac 布局不同)
const CHROME_SUBPATH =
    process.platform === 'win32'
        ? ['chrome-win64', 'chrome.exe']
        : ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'];

// 校验产物:确认 Chromium 主程序确实就位,返回其路径(找不到返回 null)
function findChromeBinary() {
    if (!fs.existsSync(dest)) return null;
    return fs
        .readdirSync(dest)
        .filter((d) => d.startsWith('chromium-'))
        .map((d) => path.join(dest, d, ...CHROME_SUBPATH))
        .find((p) => fs.existsSync(p));
}

// 3) 快路径:版本标记匹配且 Chromium 主程序在位 → 复用缓存,跳过下载
if (fs.existsSync(versionMark)) {
    const cachedVersion = fs.readFileSync(versionMark, 'utf8').trim();
    const chromeBin = findChromeBinary();
    if (cachedVersion === pwVersion && chromeBin) {
        console.log(
            `[打包浏览器] 已是当前版本 ${pwVersion} 且 Chromium 在位,复用缓存,跳过下载:\n` +
                `            ${chromeBin}`
        );
        process.exit(0);
    }
    console.log(
        `[打包浏览器] 缓存版本(${cachedVersion || '空'})与当前 playwright(${pwVersion})不一致或产物缺失,重新下载。`
    );
}

// 4) 慢路径:清空目标目录,保证只含当前版本浏览器
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

// 5) 用本地 playwright 下载 Chromium 到指定目录(自带 ffmpeg 等依赖)
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

// 6) 校验产物:确认 Chromium 主程序确实就位
const chromeBin = findChromeBinary();
if (!chromeBin) {
    console.error('[打包浏览器] 错误:下载完成但未找到 Chromium 主程序,产物异常,终止。');
    process.exit(1);
}

// 7) 写入版本标记,供下次打包判断是否可复用
fs.writeFileSync(versionMark, pwVersion, 'utf8');
console.log(`[打包浏览器] 完成,已就位:${chromeBin}(已记录版本 ${pwVersion})`);
