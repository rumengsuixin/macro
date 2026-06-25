// 运行时环境引导:必须在任何会 import 'playwright' 的模块之前执行。
// 原因:playwright 在模块初始化时一次性读取 PLAYWRIGHT_BROWSERS_PATH 求出浏览器目录,
// 之后再改该环境变量无效。若 main.ts 先 import 了 macro-runner(其顶部 import 'playwright'),
// 等到后面才设置环境变量就已经太晚,Playwright 会锁死系统默认缓存路径而找不到自带 Chromium。
// 故把环境变量设置抽到这个纯副作用模块,并让 main.ts 第一行就 import 它。
import { app } from 'electron';
import path from 'node:path';

// 打包后:① 让 Playwright 用随安装包分发、已解压在安装目录 resources/ms-playwright 的浏览器;
//        ② 让 core 把 ai-config.json 等写到用户可写目录(asar 只读)。
if (app.isPackaged) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'ms-playwright');
    process.env.MACRO_DATA_DIR = app.getPath('userData');
}
