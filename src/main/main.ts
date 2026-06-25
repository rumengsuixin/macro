// Electron 主进程入口:创建窗口、注册 IPC、持有 Playwright 回放引擎。
// 注:runtime-bootstrap 必须放在所有 import 最前(尤其在引入 macro-runner/playwright 之前),
// 它负责在 playwright 初始化前设好 PLAYWRIGHT_BROWSERS_PATH,否则自带 Chromium 路径不生效。
import './runtime-bootstrap';
import { app, BrowserWindow, ipcMain, dialog, shell, session, type Cookie } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { MacroRunner } from '../core/macro-runner';
import { exportToExcel } from '../core/excel-exporter';
import { setLogSink, logInfo, logError } from '../core/logger';
import { saveMacro, loadMacro } from '../storage/macro-store';
import { loadBrowserConfig, saveBrowserConfig } from '../storage/browser-config-store';
import { generateExtract, listProfiles, loadAiConfig, getConfigPath, importAiConfig, type GenerateInput } from '../core/ai-extract';
import type {
    Macro,
    ExtractRow,
    RunResult,
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
const examplesDir = path.join(projectRoot, 'examples'); // 只读示例,留在程序目录内

// 浏览器登录态复用配置:文件路径与默认 profile 目录
const browserConfigPath = path.join(dataRoot, 'browser-config.json');
const defaultProfileDir = path.join(dataRoot, 'browser-profile');

// webview 录制 preload 的绝对路径(与 main.js 同目录)
const webviewPreloadPath = path.join(__dirname, 'webview-preload.js');

let mainWindow: BrowserWindow | null = null;

// 每次运行宏分配递增 runId,用于隔离不同次运行的「继续」信号,避免串信号/误触发
let runSeq = 0;

/** 确保运行时目录存在 */
function ensureDirs(): void {
    for (const dir of [macrosDir, exportsDir, errorsDir]) {
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

    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

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

    ipcMain.handle('save-macro', async (_e, macro: Macro): Promise<string | null> => {
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
        logInfo(`宏已保存:${saved}`);
        return saved;
    });

    ipcMain.handle('load-macro', async (): Promise<Macro | null> => {
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
            const macro = await loadMacro(result.filePaths[0]);
            logInfo(`宏已加载:${result.filePaths[0]}(${macro.steps.length} 个步骤)`);
            return macro;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`加载宏失败:${message}`);
            throw err;
        }
    });

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
        const sessionOptions = await buildSessionOptions();
        const runner = new MacroRunner(errorsDir, undefined, onPause, sessionOptions);
        try {
            return await runner.run(macro);
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
                `注入录制登录=${next.injectRecordingSession ? '开' : '关'}、目录=${next.userDataDir}`
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
    return options;
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
