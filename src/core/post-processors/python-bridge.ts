// Python 子进程桥接:spawn 一个 Python 脚本,收集全部输出、按退出码判成败。
// 纯 Node child_process,不依赖 Electron。供 bank-integrate 等后处理器调用外部 Python 工具。
// 关键:强制 Python 用 UTF-8 输出(PYTHONIOENCODING/PYTHONUTF8),否则 Windows GBK 控制台会把
// 中文日志编码报错/乱码;stdout/stderr 完整累积不截断(遵守「禁止人为截断数据」铁律)。
import { spawn, type ChildProcess } from 'node:child_process';

export interface RunPythonOptions {
    /** Python 可执行文件路径(开发态=venv python;分发态=打包二进制) */
    exe: string;
    /** 传给 Python 的参数,如 ['整合1.py'] */
    args: string[];
    /** 子进程工作目录(Python 项目根) */
    cwd: string;
    /** 追加/覆盖的环境变量(与 process.env 合并) */
    env?: Record<string, string>;
    /** 超时毫秒,超时 kill 子进程;缺省 300000 */
    timeoutMs?: number;
    /** 逐行日志回调(stdout/stderr 每完整一行触发一次) */
    onLog?: (line: string) => void;
}

export interface RunPythonResult {
    /** 退出码;子进程无法启动(如 exe 不存在)时为 null */
    exitCode: number | null;
    /** 完整 stdout(不截断) */
    stdout: string;
    /** 完整 stderr(不截断) */
    stderr: string;
    /** 是否因超时被 kill */
    timedOut: boolean;
}

/**
 * 运行一个 Python 脚本,Promise 永远 resolve(不 reject):
 * 失败信息通过 exitCode/stderr/timedOut 表达,由调用方决定如何处理。
 */
export function runPython(opts: RunPythonOptions): Promise<RunPythonResult> {
    const { exe, args, cwd, env, timeoutMs = 300000, onLog } = opts;
    return new Promise<RunPythonResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        // 逐行缓冲(仅供 onLog 实时转发用,与完整 stdout/stderr 累积互不影响)
        let outLineBuf = '';
        let errLineBuf = '';

        let child: ChildProcess;
        try {
            child = spawn(exe, args, {
                cwd,
                env: {
                    ...process.env,
                    PYTHONIOENCODING: 'utf-8',
                    PYTHONUTF8: '1',
                    ...env,
                },
                windowsHide: true,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            resolve({ exitCode: null, stdout: '', stderr: message, timedOut: false });
            return;
        }

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);

        /** 累积完整输出 + 逐行转发 onLog */
        const feed = (chunk: Buffer, isErr: boolean): void => {
            const text = chunk.toString('utf-8');
            if (isErr) {
                stderr += text;
            } else {
                stdout += text;
            }
            if (!onLog) {
                return;
            }
            let buf = (isErr ? errLineBuf : outLineBuf) + text;
            let idx: number;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).replace(/\r$/, '');
                buf = buf.slice(idx + 1);
                if (line) {
                    onLog(line);
                }
            }
            if (isErr) {
                errLineBuf = buf;
            } else {
                outLineBuf = buf;
            }
        };

        child.stdout?.on('data', (c: Buffer) => feed(c, false));
        child.stderr?.on('data', (c: Buffer) => feed(c, true));

        const finish = (exitCode: number | null): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (onLog) {
                // flush 残留的不完整行
                const outRest = outLineBuf.trim();
                const errRest = errLineBuf.trim();
                if (outRest) {
                    onLog(outRest);
                }
                if (errRest) {
                    onLog(errRest);
                }
            }
            resolve({ exitCode, stdout, stderr, timedOut });
        };

        child.on('error', (err: Error) => {
            // exe 不存在等启动失败
            stderr += err.message;
            finish(null);
        });
        child.on('close', (code: number | null) => finish(code));
    });
}
