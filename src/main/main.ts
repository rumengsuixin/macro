// Electron 主进程入口:创建窗口、注册 IPC、持有 Playwright 回放引擎。
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { MacroRunner } from '../core/macro-runner';
import { exportToExcel } from '../core/excel-exporter';
import { setLogSink, logInfo, logError } from '../core/logger';
import { saveMacro, loadMacro } from '../storage/macro-store';
import { generateExtract, listProfiles, type GenerateInput } from '../core/ai-extract';
import type { Macro, ExtractRow, RunResult } from '../core/macro-types';

// 目录约定(相对于项目根目录;__dirname 运行时为 dist/main)
const projectRoot = path.resolve(__dirname, '..', '..');
const macrosDir = path.join(projectRoot, 'macros');
const exportsDir = path.join(projectRoot, 'exports');
const errorsDir = path.join(projectRoot, 'errors');
const examplesDir = path.join(projectRoot, 'examples');

// webview 录制 preload 的绝对路径(与 main.js 同目录)
const webviewPreloadPath = path.join(__dirname, 'webview-preload.js');

let mainWindow: BrowserWindow | null = null;

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

    ipcMain.handle('run-macro', async (_e, macro: Macro): Promise<RunResult> => {
        const runner = new MacroRunner(errorsDir);
        try {
            return await runner.run(macro);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`运行宏时发生未捕获错误:${message}`);
            return { ok: false, error: { stepIndex: -1, stepType: 'goto', message } };
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
