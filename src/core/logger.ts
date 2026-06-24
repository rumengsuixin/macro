// 中文日志工具(主进程使用)。
// 同时输出到控制台,并通过 IPC 推送到渲染进程的日志区域。
import type { WebContents } from 'electron';

type LogLevel = 'info' | 'error';

export interface LogMessage {
    level: LogLevel;
    message: string;
    time: string;
}

let sink: WebContents | null = null;

/** 设置日志接收端(渲染进程的 webContents),由主进程在窗口创建后调用 */
export function setLogSink(wc: WebContents): void {
    sink = wc;
}

function emit(level: LogLevel, message: string): void {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const payload: LogMessage = { level, message, time };

    if (level === 'error') {
        console.error(`[${time}] ${message}`);
    } else {
        console.log(`[${time}] ${message}`);
    }

    if (sink && !sink.isDestroyed()) {
        sink.send('log', payload);
    }
}

/** 普通信息日志 */
export function logInfo(message: string): void {
    emit('info', message);
}

/** 错误日志 */
export function logError(message: string): void {
    emit('error', message);
}
