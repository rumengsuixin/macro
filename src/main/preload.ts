// 主窗口 preload:通过 contextBridge 向渲染进程安全地暴露 electronAPI。
// 渲染进程只能通过这些方法与主进程通信,Playwright 等对象不会暴露给渲染进程。
import { contextBridge, ipcRenderer } from 'electron';
import type { Macro, MacroCaptures, MacroSummary, ExtractRow, RunResult, BrowserConfig, PostProcessorManifest, PostProcessResult } from '../core/macro-types';
import type { LogMessage } from '../core/logger';
import type { GenerateInput, GenerateResult, ProfileSummary, FixSelectorInput, FixSelectorResult } from '../core/ai-extract';

/** AI 配置档列表返回结构 */
export interface AiProfilesInfo {
    profiles: ProfileSummary[];
    defaultProfile: string;
}
type AiGenerateInput = GenerateInput;
type AiGenerateResult = GenerateResult;

/** 回放暂停事件:主进程在执行到 pause 步骤时推送 */
export interface PauseEvent {
    runId: number;
    stepIndex: number;
    reason?: string;
    timeout?: number;
}

const api = {
    /** 获取 webview 录制 preload 的绝对路径 */
    getWebviewPreloadPath: (): Promise<string> => ipcRenderer.invoke('get-webview-preload-path'),

    /** 保存宏(弹出保存对话框),返回写入路径或 null(取消);captures 为离线校正用的选择器上下文旁车 */
    saveMacro: (macro: Macro, captures?: MacroCaptures | null): Promise<string | null> =>
        ipcRenderer.invoke('save-macro', macro, captures),

    /** 加载宏(弹出打开对话框),返回 {macro, captures, filePath} 或 null(取消) */
    loadMacro: (): Promise<{ macro: Macro; captures: MacroCaptures | null; filePath: string } | null> =>
        ipcRenderer.invoke('load-macro'),

    /** 静默持久化宏 + 旁车到指定路径(不弹对话框),供实时自动保存;返回写入路径或 null */
    persistMacro: (macro: Macro, captures: MacroCaptures | null, filePath: string): Promise<string | null> =>
        ipcRenderer.invoke('persist-macro', macro, captures, filePath),

    /** 列出 macros/ 目录下所有宏摘要(驱动宏库面板) */
    listMacros: (): Promise<MacroSummary[]> => ipcRenderer.invoke('list-macros'),

    /** 按路径读取宏(不弹对话框),返回 {macro, captures, filePath} 或 null;供宏库面板「打开」/「后台运行」 */
    readMacro: (filePath: string): Promise<{ macro: Macro; captures: MacroCaptures | null; filePath: string } | null> =>
        ipcRenderer.invoke('read-macro', filePath),

    /** 运行宏,返回结构化结果 */
    runMacro: (macro: Macro): Promise<RunResult> => ipcRenderer.invoke('run-macro', macro),

    /** 导出 Excel(弹出保存对话框),返回文件路径或 null(取消) */
    exportExcel: (rows: ExtractRow[]): Promise<string | null> => ipcRenderer.invoke('export-excel', rows),

    /** 列出可用后处理器插件(驱动可选插件列表) */
    listPlugins: (): Promise<PostProcessorManifest[]> => ipcRenderer.invoke('list-plugins'),

    /** 直接运行某插件(弹文件夹选择,对其内文件直接处理,不跑宏) */
    runPlugin: (type: string): Promise<{ canceled?: boolean; results?: PostProcessResult[] }> =>
        ipcRenderer.invoke('run-plugin', type),

    /** 列出 AI 配置档 */
    aiListProfiles: (): Promise<AiProfilesInfo> => ipcRenderer.invoke('ai-list-profiles'),

    /** 调用 AI 生成提取规则 */
    aiGenerateExtract: (input: AiGenerateInput): Promise<AiGenerateResult> =>
        ipcRenderer.invoke('ai-generate-extract', input),

    /** 调用 AI 校正单个步骤的脆弱选择器 */
    aiFixSelector: (input: FixSelectorInput): Promise<FixSelectorResult> =>
        ipcRenderer.invoke('ai-fix-selector', input),

    /** 上传并校验 ai-config.json,通过则覆盖生效 */
    importAiConfig: (): Promise<{ ok: boolean; error?: string; canceled?: boolean; profileCount?: number }> =>
        ipcRenderer.invoke('import-ai-config'),

    /** 读取浏览器登录态复用配置 */
    getBrowserConfig: (): Promise<BrowserConfig> => ipcRenderer.invoke('get-browser-config'),

    /** 更新浏览器登录态复用配置(传 patch),返回最新配置 */
    setBrowserConfig: (patch: Partial<BrowserConfig>): Promise<BrowserConfig> =>
        ipcRenderer.invoke('set-browser-config', patch),

    /** 弹目录对话框选择 profile 目录,返回路径或 null(取消) */
    chooseUserDataDir: (): Promise<string | null> => ipcRenderer.invoke('choose-user-data-dir'),

    /** 订阅主进程日志推送 */
    onLog: (callback: (msg: LogMessage) => void): void => {
        ipcRenderer.on('log', (_event, msg: LogMessage) => callback(msg));
    },

    /** 订阅回放暂停事件(执行到 pause 步骤时触发) */
    onMacroPaused: (callback: (info: PauseEvent) => void): void => {
        ipcRenderer.on('macro-paused', (_event, info: PauseEvent) => callback(info));
    },

    /** 通知主进程「继续」回放(需带回对应的 runId) */
    resumeMacro: (runId: number): void => {
        ipcRenderer.send('resume-macro', runId);
    },

    /** 订阅「本次运行已开始」事件(带 runId,供停止按钮回传) */
    onMacroRunStarted: (callback: (info: { runId: number }) => void): void => {
        ipcRenderer.on('macro-run-started', (_event, info: { runId: number }) => callback(info));
    },

    /** 通知主进程「停止」回放(需带回对应的 runId) */
    stopMacro: (runId: number): void => {
        ipcRenderer.send('stop-macro', runId);
    },
};

contextBridge.exposeInMainWorld('electronAPI', api);

export type ElectronAPI = typeof api;
