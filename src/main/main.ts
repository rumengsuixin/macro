// Electron 主进程入口:创建窗口、注册 IPC、持有 Playwright 回放引擎。
// 注:runtime-bootstrap 必须放在所有 import 最前(尤其在引入 macro-runner/playwright 之前),
// 它负责在 playwright 初始化前设好 PLAYWRIGHT_BROWSERS_PATH,否则自带 Chromium 路径不生效。
import './runtime-bootstrap';
import { app, BrowserWindow, ipcMain, dialog, shell, session, type Cookie, type WebContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { MacroRunner } from '../core/macro-runner';
import { exportToExcel } from '../core/excel-exporter';
import { setLogSink, logInfo, logError } from '../core/logger';
import { saveMacro, loadMacro, saveMacroCaptures, loadMacroCaptures, listMacros } from '../storage/macro-store';
import { loadBrowserConfig, saveBrowserConfig } from '../storage/browser-config-store';
import { loadRequestRules } from '../storage/request-rules-store';
// 注:RequestInterceptor(录制端 CDP 拦截器)已不再由主进程接线——拦截模块仅在回放阶段生效(见 did-attach-webview)。
// 类文件仍保留(供自检脚本 verify-request-intercept / verify-timeline-record 直接实例化)。
import { generateExtract, fixSelector, listProfiles, loadAiConfig, getConfigPath, importAiConfig, type GenerateInput, type FixSelectorInput } from '../core/ai-extract';
import { runPostProcessors, listPostProcessors } from '../core/post-processors';
import type {
    Macro,
    MacroCaptures,
    ExtractRow,
    RunResult,
    PostProcessResult,
    OnPause,
    PauseInfo,
    BrowserConfig,
    BrowserCookie,
    SessionOptions,
} from '../core/macro-types';

// 目录约定:开发时用项目根;打包后(asar 只读)数据写到用户可写目录 userData
// 注:打包态 userData 文件夹名取自 package.json 的 name=macro-recorder,即 %APPDATA%\macro-recorder
const projectRoot = path.resolve(__dirname, '..', '..');
const dataRoot = app.isPackaged ? app.getPath('userData') : projectRoot;

// 注:打包态的环境变量(PLAYWRIGHT_BROWSERS_PATH / MACRO_DATA_DIR)已在 runtime-bootstrap 中
// 于 playwright 初始化前提前设置,此处不再重复设置(dataRoot 与 bootstrap 取值一致)。

const macrosDir = path.join(dataRoot, 'macros');
const exportsDir = path.join(dataRoot, 'exports');
const errorsDir = path.join(dataRoot, 'errors');
const downloadsDir = path.join(dataRoot, 'downloads');
const timelinesDir = path.join(dataRoot, 'timelines'); // 「只记录不修改」支路的请求时间线 JSONL 输出
const dumpsDir = path.join(dataRoot, 'dumps'); // 「请求体落盘」支路的二进制请求体输出(如上传视频落成 mp4)
const examplesDir = path.join(projectRoot, 'examples'); // 只读示例,留在程序目录内

// 浏览器登录态复用配置:文件路径与默认 profile 目录
const browserConfigPath = path.join(dataRoot, 'browser-config.json');
const defaultProfileDir = path.join(dataRoot, 'browser-profile');

// 录制端请求改写规则:文件路径(默认 enabled=false,不干预录制)
const requestRulesPath = path.join(dataRoot, 'request-rules.json');

// webview 录制 preload 的绝对路径(与 main.js 同目录)
const webviewPreloadPath = path.join(__dirname, 'webview-preload.js');

let mainWindow: BrowserWindow | null = null;

// 录制 <webview> 的 guest webContents 引用:用于回放前读取其当前页 origin 的 localStorage
// (localStorage 无 session 级 API,只能在页面上下文里读,故经此引用 executeJavaScript)
let recordingWebContents: WebContents | null = null;

// 每次运行宏分配递增 runId,用于隔离不同次运行的「继续」信号,避免串信号/误触发
let runSeq = 0;

/** 确保运行时目录存在 */
function ensureDirs(): void {
    for (const dir of [macrosDir, exportsDir, errorsDir, downloadsDir, timelinesDir, dumpsDir]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        title: '网页宏录制工具',
        // 应用图标(与主页 🐟「二爪鱼」品牌一致);打包态 projectRoot 指向 asar 根,assets 已随包
        icon: path.join(projectRoot, 'assets', 'icon.ico'),
        // 与 index.html body 背景一致,消除窗口首帧白底闪烁
        backgroundColor: '#f3f4f6',
        // 先不显示,等首帧可绘制(ready-to-show)再显示,避免白屏
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: true, // 启用 <webview> 内置浏览器
            sandbox: true,
        },
    });

    // 为内嵌 <webview> 强制注入录制 preload,并关闭其沙箱
    // (沙箱关闭后 preload 才能 require 本地编译产物 selector-generator)
    mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
        webPreferences.preload = webviewPreloadPath;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = false;
    });

    // 拦截 webview 内的「新标签页」导航(target=_blank / window.open):
    // Electron 默认会丢弃这类弹窗,导致录制时点击「没反应」、新页面操作无从记录。
    // 这里拒绝新建窗口,改为在同一 webview 内打开,保证录制连续(后续操作正常录制)。
    mainWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
        // 持有 guest 引用供回放前读取 localStorage;webview 销毁时置回 null 防失效引用
        recordingWebContents = guestContents;
        // 注:请求拦截模块(改写/重发/响应头/真拦截)现仅在**回放阶段**生效——录制端不再挂 CDP 拦截器,
        // 保证录制时抓到真实、未改动的流量,也不与用户手开的 DevTools 抢占 debugger。
        // 拦截规则(request-rules.json)只在回放时经 buildSessionOptions 下发给 MacroRunner。
        guestContents.once('destroyed', () => {
            if (recordingWebContents === guestContents) {
                recordingWebContents = null;
            }
        });
        guestContents.setWindowOpenHandler(({ url }) => {
            if (url && url !== 'about:blank') {
                void guestContents.loadURL(url);
            }
            return { action: 'deny' };
        });
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    // 首帧可绘制后再显示窗口,避免「先白屏后跳出界面」
    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });

    mainWindow.webContents.on('did-finish-load', () => {
        if (mainWindow) {
            setLogSink(mainWindow.webContents);
            logInfo('应用已启动,可在地址栏输入网址并打开网页。');
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

/** 注册所有 IPC 处理器 */
function registerIpc(): void {
    ipcMain.handle('get-webview-preload-path', () => webviewPreloadPath);

    ipcMain.handle(
        'save-macro',
        async (_e, macro: Macro, captures?: MacroCaptures | null): Promise<string | null> => {
            const safeName = (macro.name || 'macro').replace(/[\\/:*?"<>|]/g, '_');
            const result = await dialog.showSaveDialog(mainWindow!, {
                title: '保存宏',
                defaultPath: path.join(macrosDir, `${safeName}.json`),
                filters: [{ name: 'JSON 宏文件', extensions: ['json'] }],
            });
            if (result.canceled || !result.filePath) {
                logInfo('已取消保存宏。');
                return null;
            }
            const saved = await saveMacro(macro, result.filePath);
            // 旁车上下文(离线 AI 校正用):有则写、无则清旧旁车。失败不致命
            try {
                await saveMacroCaptures(saved, captures);
            } catch (err) {
                logError(`保存选择器上下文旁车失败(不影响宏):${(err as Error).message}`);
            }
            logInfo(`宏已保存:${saved}`);
            return saved;
        }
    );

    ipcMain.handle(
        'load-macro',
        async (): Promise<{ macro: Macro; captures: MacroCaptures | null; filePath: string } | null> => {
            const result = await dialog.showOpenDialog(mainWindow!, {
                title: '加载宏',
                defaultPath: fs.existsSync(examplesDir) ? examplesDir : macrosDir,
                properties: ['openFile'],
                filters: [{ name: 'JSON 宏文件', extensions: ['json'] }],
            });
            if (result.canceled || result.filePaths.length === 0) {
                logInfo('已取消加载宏。');
                return null;
            }
            try {
                const filePath = result.filePaths[0];
                const macro = await loadMacro(filePath);
                const captures = await loadMacroCaptures(filePath);
                logInfo(
                    `宏已加载:${filePath}(${macro.steps.length} 个步骤` +
                        (captures ? `,含选择器上下文旁车` : '') +
                        `)`
                );
                // 回传 filePath:渲染进程据此追踪当前宏文件,做实时自动保存(宏 + 旁车)
                return { macro, captures, filePath };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logError(`加载宏失败:${message}`);
                throw err;
            }
        }
    );

    // 静默持久化宏 + 旁车到指定路径(不弹对话框):供渲染进程「自动保存」调用。
    // 与 save-macro 的区别是不弹保存对话框、直接写入 filePath(由 load / 首次手动保存建立的当前路径)。
    ipcMain.handle(
        'persist-macro',
        async (_e, macro: Macro, captures: MacroCaptures | null, filePath: string): Promise<string | null> => {
            if (!filePath || typeof filePath !== 'string') {
                return null;
            }
            const saved = await saveMacro(macro, filePath);
            // 旁车上下文(离线 AI 校正用):有则写、无则清旧旁车。失败不致命
            try {
                await saveMacroCaptures(saved, captures);
            } catch (err) {
                logError(`自动保存选择器上下文旁车失败(不影响宏):${(err as Error).message}`);
            }
            return saved;
        }
    );

    // 列出 macros/ 目录下所有宏摘要(驱动渲染进程的宏库面板)
    ipcMain.handle('list-macros', async () => {
        ensureDirs();
        return listMacros(macrosDir);
    });

    // 用系统文件管理器打开默认加载宏的目录(宏库面板「打开文件夹」)
    ipcMain.handle('open-macros-dir', async () => {
        ensureDirs();
        return shell.openPath(macrosDir);
    });

    // 按路径读取宏(无对话框):语义同 load-macro 但不弹框,供宏库面板「打开」/「后台运行」取宏对象
    ipcMain.handle(
        'read-macro',
        async (_e, filePath: string): Promise<{ macro: Macro; captures: MacroCaptures | null; filePath: string } | null> => {
            if (!filePath || typeof filePath !== 'string') {
                return null;
            }
            try {
                const macro = await loadMacro(filePath);
                const captures = await loadMacroCaptures(filePath);
                return { macro, captures, filePath };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logError(`读取宏失败:${message}`);
                return null;
            }
        }
    );

    ipcMain.handle('run-macro', async (e, macro: Macro): Promise<RunResult> => {
        const runId = ++runSeq;
        const wc = e.sender;
        // 本次运行注册的 resume 监听器,finally 统一移除,防泄漏/串信号
        const listeners: Array<() => void> = [];

        // 人工介入暂停回调:通知渲染进程弹模态框,并等待匹配 runId 的「继续」信号
        const onPause: OnPause = (info: PauseInfo) =>
            new Promise<void>((resolve, reject) => {
                const resumeListener = (_ev: unknown, id: number): void => {
                    if (id !== runId) {
                        return; // 非本次运行的信号,忽略
                    }
                    ipcMain.removeListener('resume-macro', resumeListener);
                    resolve();
                };
                const destroyedListener = (): void => {
                    ipcMain.removeListener('resume-macro', resumeListener);
                    reject(new Error('回放暂停期间窗口被关闭,回放中断。'));
                };
                ipcMain.on('resume-macro', resumeListener);
                wc.once('destroyed', destroyedListener);
                listeners.push(() => {
                    ipcMain.removeListener('resume-macro', resumeListener);
                    wc.removeListener('destroyed', destroyedListener);
                });
                // 通知渲染进程:回放已暂停,显示模态框
                if (!wc.isDestroyed()) {
                    wc.send('macro-paused', { runId, ...info });
                }
            });

        // 运行前组装会话选项:持久化目录 + 录制 cookie 注入(均按 browser-config.json 开关)
        ensureDirs();
        const sessionOptions = await buildSessionOptions();
        const runner = new MacroRunner(
            errorsDir,
            undefined,
            onPause,
            sessionOptions,
            downloadsDir,
            timelinesDir,
            dumpsDir
        );

        // 「停止回放」信号:匹配 runId 时调用 runner.cancel() 主动中止(与 resume 同一 runId 隔离机制)
        const stopListener = (_ev: unknown, id: number): void => {
            if (id !== runId) {
                return; // 非本次运行的信号,忽略
            }
            runner.cancel();
        };
        ipcMain.on('stop-macro', stopListener);
        listeners.push(() => ipcMain.removeListener('stop-macro', stopListener));

        // 运行期热更新:盯 request-rules.json,改动即把最新规则(改写 + 记录)推给正在跑的 runner,
        // 让回放中途也能开关拦截/记录(复刻录制端 RequestInterceptor 的 fs.watchFile 热更新)。
        const rulesWatcher = (): void => runner.updateRequestRules(loadRequestRules(requestRulesPath));
        try {
            fs.watchFile(requestRulesPath, { interval: 1000 }, rulesWatcher);
        } catch {
            /* 监听失败不致命,仅失去回放期热更新 */
        }
        listeners.push(() => {
            try {
                fs.unwatchFile(requestRulesPath, rulesWatcher);
            } catch {
                /* 忽略 */
            }
        });

        // 通知渲染进程:本次运行已开始(带 runId),供其「停止回放」按钮回传对应 runId
        if (!wc.isDestroyed()) {
            wc.send('macro-run-started', { runId });
        }

        try {
            const result = await runner.run(macro);
            if (result.ok && result.downloads && result.downloads.length > 0) {
                logInfo(`已下载 ${result.downloads.length} 个文件到:${downloadsDir}`);
            }
            // 回放成功且配置了后处理器时执行(如 list-action 下载后合并 zip 内 excel)
            if (result.ok && macro.postProcess && macro.postProcess.length > 0) {
                const postProcessed = await runPostProcessors(macro.postProcess, {
                    downloads: result.downloads ?? [],
                    downloadDir: downloadsDir,
                    exportsDir,
                    stamp: timestamp(),
                    dataRoot,
                });
                result.postProcessed = postProcessed;
            }
            // 在文件管理器中定位:优先定位后处理产物,否则定位首个下载文件
            const producedFile = result.postProcessed?.filter((r) => r.output).pop()?.output;
            if (producedFile) {
                shell.showItemInFolder(producedFile);
            } else if (result.downloads && result.downloads.length > 0) {
                shell.showItemInFolder(result.downloads[0]);
            }
            return result;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`运行宏时发生未捕获错误:${message}`);
            return { ok: false, error: { stepIndex: -1, stepType: 'goto', message } };
        } finally {
            // 清理本次运行注册的所有监听器(单窗单跑场景已足够;并发多窗需按窗口隔离)
            for (const off of listeners) {
                off();
            }
        }
    });

    ipcMain.handle('export-excel', async (_e, rows: ExtractRow[]): Promise<string | null> => {
        ensureDirs();
        // 弹出保存对话框,默认目录 exports/、默认名 result-时间戳.xlsx
        const result = await dialog.showSaveDialog(mainWindow!, {
            title: '导出 Excel',
            defaultPath: path.join(exportsDir, `result-${timestamp()}.xlsx`),
            filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
        });
        if (result.canceled || !result.filePath) {
            logInfo('已取消导出 Excel。');
            return null;
        }
        const saved = await exportToExcel(rows ?? [], result.filePath);
        logInfo(`Excel 已导出:${saved}`);
        shell.showItemInFolder(saved); // 打开所在文件夹并高亮该文件
        return saved;
    });

    // 列出可用后处理器插件(驱动渲染进程的可选插件列表)
    ipcMain.handle('list-plugins', () => {
        return listPostProcessors();
    });

    // 直接运行某插件:弹文件多选(zip/csv/xls/xlsx,默认定位 downloads/),对所选文件直接跑后处理,不回放宏
    ipcMain.handle(
        'run-plugin',
        async (_e, type: string): Promise<{ canceled?: boolean; results?: PostProcessResult[] }> => {
            ensureDirs();
            // 「直接运行」通道服务两类:附加处理(合并)与独立工具(银行整合/对账,代号2 需 pdf),
            // 故文案中性化、过滤器取并集(补 pdf),保留「所有文件」兜底。
            const pick = await dialog.showOpenDialog(mainWindow!, {
                title: '选择要处理的文件(可多选 zip / csv / xls / xlsx / pdf)',
                defaultPath: downloadsDir,
                properties: ['openFile', 'multiSelections'],
                filters: [
                    { name: '支持的文件', extensions: ['zip', 'csv', 'xls', 'xlsx', 'xlsm', 'pdf'] },
                    { name: '所有文件', extensions: ['*'] },
                ],
            });
            if (pick.canceled || pick.filePaths.length === 0) {
                logInfo('已取消直接运行插件。');
                return { canceled: true };
            }
            const files = pick.filePaths;
            logInfo(`直接运行插件 ${type}:已选 ${files.length} 个文件。`);
            const results = await runPostProcessors([{ type }], {
                downloads: files,
                downloadDir: path.dirname(files[0]),
                exportsDir,
                stamp: timestamp(),
                dataRoot,
            });
            const out = results.filter((r) => r.output).pop()?.output;
            if (out) {
                shell.showItemInFolder(out);
            }
            return { results };
        }
    );

    // 列出 AI 配置档(供渲染进程下拉选择)
    ipcMain.handle('ai-list-profiles', async () => {
        return listProfiles();
    });

    // 上传 ai-config.json:弹打开对话框选文件 → 校验格式 → 通过则覆盖生效
    ipcMain.handle('import-ai-config', async () => {
        const result = await dialog.showOpenDialog(mainWindow!, {
            title: '选择 ai-config.json 文件',
            defaultPath: getConfigPath(),
            properties: ['openFile'],
            filters: [{ name: 'JSON 配置文件', extensions: ['json'] }],
        });
        if (result.canceled || result.filePaths.length === 0) {
            return { ok: false, canceled: true };
        }
        const r = importAiConfig(result.filePaths[0]);
        if (r.ok) {
            logInfo(`ai-config.json 已导入并生效:${result.filePaths[0]}(共 ${r.profileCount} 个配置档)`);
        } else {
            logError(`导入 ai-config.json 失败:${r.error}`);
        }
        return r;
    });

    // 调用 AI 生成提取规则
    ipcMain.handle('ai-generate-extract', async (_e, input: GenerateInput) => {
        const reqText = (input?.requirement || '').trim() || '(未填写需求)';
        logInfo(`AI 提取:配置档=${input?.profileId ?? '默认'},目标模式=${input?.mode ?? '未指定'},需求=「${reqText}」,正在请求……`);
        const result = await generateExtract(input);
        if (result.ok) {
            logInfo(`AI 提取成功(${result.profileLabel},耗时 ${result.elapsedMs}ms),已生成规则。`);
        } else {
            logError(`AI 提取失败(${result.profileLabel || input?.profileId || '未知'}):${result.error}`);
        }
        return result;
    });

    // 调用 AI 校正单个步骤的脆弱选择器(renderer 已在真实 webview 定位元素、取上下文)
    ipcMain.handle('ai-fix-selector', async (_e, input: FixSelectorInput) => {
        logInfo(`AI 校正选择器:配置档=${input?.profileId ?? 'selector-fix'},当前=「${input?.current ?? ''}」,正在请求……`);
        const result = await fixSelector(input);
        if (result.ok) {
            logInfo(`AI 校正选择器成功(${result.profileLabel},耗时 ${result.elapsedMs}ms):${result.selector}`);
        } else {
            logError(`AI 校正选择器失败(${result.profileLabel || input?.profileId || 'selector-fix'}):${result.error}`);
        }
        return result;
    });

    // 读取浏览器登录态复用配置(供渲染层回填面板)
    ipcMain.handle('get-browser-config', (): BrowserConfig => {
        return loadBrowserConfig(browserConfigPath, defaultProfileDir);
    });

    // 更新配置(渲染层传 patch,合并后写回并返回最新)
    ipcMain.handle('set-browser-config', (_e, patch: Partial<BrowserConfig>): BrowserConfig => {
        const current = loadBrowserConfig(browserConfigPath, defaultProfileDir);
        const next: BrowserConfig = { ...current, ...(patch ?? {}) };
        saveBrowserConfig(browserConfigPath, next);
        logInfo(
            `浏览器登录态配置已更新:持久化=${next.persistProfile ? '开' : '关'}、` +
                `注入录制登录=${next.injectRecordingSession ? '开' : '关'}、` +
                `本机 Chrome 内核=${next.useSystemChrome ? '开' : '关'}、目录=${next.userDataDir}`
        );
        return next;
    });

    // 选择 profile 目录(目录对话框),返回所选路径或 null(取消)
    ipcMain.handle('choose-user-data-dir', async (): Promise<string | null> => {
        const result = await dialog.showOpenDialog(mainWindow!, {
            title: '选择浏览器 profile 目录',
            defaultPath: loadBrowserConfig(browserConfigPath, defaultProfileDir).userDataDir,
            properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        return result.filePaths[0];
    });
}

/** 依据 browser-config.json 组装回放会话选项(持久化目录 + 录制 cookie 注入) */
async function buildSessionOptions(): Promise<SessionOptions> {
    const cfg = loadBrowserConfig(browserConfigPath, defaultProfileDir);
    const options: SessionOptions = {};
    // 优先用本机真 Chrome/Edge 内核回放(反检测);core 层据此走内核回退链
    options.preferSystemChrome = cfg.useSystemChrome;
    if (cfg.useSystemChrome) {
        logInfo('回放将优先尝试本机 Chrome/Edge 内核(反检测),失败回退捆绑 Chromium。');
    }
    if (cfg.persistProfile) {
        // 兜底建目录,避免 launchPersistentContext 因目录不存在报错
        if (!fs.existsSync(cfg.userDataDir)) {
            fs.mkdirSync(cfg.userDataDir, { recursive: true });
        }
        options.userDataDir = cfg.userDataDir;
        logInfo(`回放将复用持久化浏览器目录:${cfg.userDataDir}`);
    }
    if (cfg.injectRecordingSession) {
        // webview 用默认 session,这里导出其全部 cookies 注入回放
        const electronCookies = await session.defaultSession.cookies.get({});
        const cookies = toPlaywrightCookies(electronCookies);
        if (cookies.length > 0) {
            options.cookies = cookies;
            logInfo(`将注入录制会话 cookies:${cookies.length} 条`);
        } else {
            logInfo('录制会话无可注入的 cookies(默认 session 为空)。');
        }
    }
    if (cfg.injectRecordingLocalStorage) {
        // localStorage 无 session 级 API,只能在录制 webview 页面上下文里读;且按 origin 隔离,
        // 实时 webview 只能拿到「当前页面所在 origin」的 localStorage(已在文档注明此限制)。
        const ls = await captureRecordingLocalStorage();
        if (ls) {
            options.localStorage = { [ls.origin]: ls.items };
            logInfo(`将注入录制 localStorage:origin ${ls.origin},共 ${Object.keys(ls.items).length} 条`);
        } else {
            logInfo('录制会话无可注入的 localStorage(当前页非 http(s) 或为空)。');
        }
    }
    // 回放端请求改写 + 只记录不修改支路:复用录制端同一份 request-rules.json(与录制端共用),
    // 每次回放开始都重新读取,天然取到最新规则(无需运行中热更新)。
    // 门槛放宽:改写(enabled+规则)或记录(record.enabled)任一开启,都把 config 带给 runner——
    // record-only(改写 enabled:false)也要能记录。两支路在 runner 内各自独立判断,互不启停。
    const requestRules = loadRequestRules(requestRulesPath);
    const rewriteActive = requestRules.enabled && requestRules.rules.length > 0;
    const recordActive = requestRules.record?.enabled === true;
    const resendActive = requestRules.enabled && (requestRules.resends?.length ?? 0) > 0;
    const responseRuleActive =
        requestRules.enabled && (requestRules.responseRules?.length ?? 0) > 0;
    const blockActive = requestRules.enabled && (requestRules.blocks?.length ?? 0) > 0;
    const dumpActive = requestRules.enabled && (requestRules.dumps?.length ?? 0) > 0;
    if (
        rewriteActive ||
        recordActive ||
        resendActive ||
        responseRuleActive ||
        blockActive ||
        dumpActive
    ) {
        options.requestRules = requestRules;
        if (rewriteActive) {
            logInfo(`回放将按 ${requestRules.rules.length} 条规则改写命中的 POST 请求体。`);
        }
        if (resendActive) {
            logInfo(`回放将按 ${requestRules.resends!.length} 条重发规则在命中后延时重发请求。`);
        }
        if (responseRuleActive) {
            logInfo(
                `回放将按 ${requestRules.responseRules!.length} 条响应头规则在满足条件时改写响应头。`
            );
        }
        if (blockActive) {
            logInfo(`回放将按 ${requestRules.blocks!.length} 条真拦截规则硬阻断命中的请求。`);
        }
        if (dumpActive) {
            logInfo(
                `回放将按 ${requestRules.dumps!.length} 条落盘规则把命中请求的完整二进制请求体写成文件(dumps/)。`
            );
        }
        if (recordActive) {
            logInfo(
                `回放将记录请求时间线(只记录不修改),匹配 URL:${requestRules.record?.urlPattern || '全部'}。`
            );
        }
    }
    return options;
}

/**
 * 读取录制 webview 当前页面 origin 的 localStorage。
 * 仅当存在 guest webContents、其未销毁、且当前页 origin 为 http(s) 且 localStorage 非空时返回数据,
 * 否则返回 null(异常一律吞掉,不阻断回放)。
 */
async function captureRecordingLocalStorage(): Promise<{ origin: string; items: Record<string, string> } | null> {
    const wc = recordingWebContents;
    if (!wc || wc.isDestroyed()) {
        return null;
    }
    try {
        const result = (await wc.executeJavaScript(
            `(() => {
                try {
                    const origin = location.origin;
                    if (!origin || !/^https?:/.test(origin)) return null;
                    const items = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        if (k !== null) items[k] = localStorage.getItem(k);
                    }
                    return Object.keys(items).length > 0 ? { origin, items } : null;
                } catch (e) { return null; }
            })()`
        )) as { origin: string; items: Record<string, string> } | null;
        return result;
    } catch (err) {
        logError(`读取录制 localStorage 失败:${(err as Error).message}`);
        return null;
    }
}

/** 把 Electron cookie 转成 Playwright addCookies 形状;无 domain 或转换失败的单条跳过 */
function toPlaywrightCookies(electronCookies: Cookie[]): BrowserCookie[] {
    const out: BrowserCookie[] = [];
    for (const c of electronCookies) {
        try {
            if (!c.domain) {
                continue; // Playwright 要求 domain+path(或 url),无 domain 无法定位
            }
            const cookie: BrowserCookie = {
                name: c.name,
                value: c.value,
                domain: c.domain, // 允许前导「.」(通配子域),Playwright 接受
                path: c.path || '/',
                expires: c.expirationDate ?? -1, // 无过期则按会话 cookie
                httpOnly: c.httpOnly,
                secure: c.secure,
            };
            // sameSite 映射:unspecified 省略;None 但非 secure 时也省略(避免 addCookies 校验报错)
            if (c.sameSite === 'strict') {
                cookie.sameSite = 'Strict';
            } else if (c.sameSite === 'lax') {
                cookie.sameSite = 'Lax';
            } else if (c.sameSite === 'no_restriction' && c.secure) {
                cookie.sameSite = 'None';
            }
            out.push(cookie);
        } catch {
            // 单条转换异常跳过,不影响其余 cookies
        }
    }
    return out;
}

/** 生成形如 20260622-153012 的时间戳 */
function timestamp(): string {
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return (
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
}

app.whenReady().then(() => {
    ensureDirs();
    // 启动即确保 ai-config.json 存在(不存在则写默认配置),并打出绝对路径便于定位
    try {
        loadAiConfig();
        logInfo(`AI 配置文件路径:${getConfigPath()}`);
    } catch (err) {
        logError(`初始化 AI 配置文件失败:${(err as Error).message}`);
    }
    registerIpc();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
