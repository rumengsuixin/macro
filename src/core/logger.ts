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
    // 时间戳格式 MM-DD HH:mm:ss(补零),跨天回放也能分清日期
    const d = new Date();
    const p2 = (n: number): string => String(n).padStart(2, '0');
    const time = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
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
