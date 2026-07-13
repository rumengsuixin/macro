// 子进程桥接:spawn 一个外部程序(打包好的可执行文件 exe/二进制,或解释器),
// 收集全部输出、按退出码判成败。纯 Node child_process,不依赖 Electron。
// 供 bank-integrate 等后处理器调用外部工具。
//
// 输出编码:被调程序的 stdout/stderr 编码不确定——
//   · 直接跑的 CPython 在 PYTHONIOENCODING=utf-8 下输出 UTF-8;
//   · PyInstaller 打包的 exe 该环境变量常不生效,Windows 下 stdout 仍是 GBK。
// 故按「行 Buffer」做智能解码(UTF-8 为主,出现替换符则 GBK 兜底),两种情况中文都不乱码。
// stdout/stderr 完整累积不截断(遵守「禁止人为截断数据」铁律)。
import { spawn, type ChildProcess } from 'node:child_process';
import iconv from 'iconv-lite';

export interface RunSubprocessOptions {
    /** 可执行文件路径(打包 exe/二进制,或解释器) */
    exe: string;
    /** 传给程序的参数;可执行文件通常为 [] */
    args: string[];
    /** 子进程工作目录 */
    cwd: string;
    /** 追加/覆盖的环境变量(与 process.env 合并) */
    env?: Record<string, string>;
    /** 超时毫秒,超时 kill 子进程;缺省 300000 */
    timeoutMs?: number;
    /** 逐行日志回调(stdout/stderr 每完整一行触发一次) */
    onLog?: (line: string) => void;
}

export interface RunSubprocessResult {
    /** 退出码;子进程无法启动(如 exe 不存在)时为 null */
    exitCode: number | null;
    /** 完整 stdout(不截断) */
    stdout: string;
    /** 完整 stderr(不截断) */
    stderr: string;
    /** 是否因超时被 kill */
    timedOut: boolean;
}

/** 智能解码一行 Buffer:UTF-8 为主,含替换符(多半是 GBK 字节被误当 UTF-8)则改 GBK 重解 */
function decodeSmart(buf: Buffer): string {
    const s = buf.toString('utf8');
    if (s.includes('�')) {
        try {
            return iconv.decode(buf, 'gbk');
        } catch {
            return s;
        }
    }
    return s;
}

/**
 * 运行一个外部程序,Promise 永远 resolve(不 reject):
 * 失败信息通过 exitCode/stderr/timedOut 表达,由调用方决定如何处理。
 */
export function runSubprocess(opts: RunSubprocessOptions): Promise<RunSubprocessResult> {
    const { exe, args, cwd, env, timeoutMs = 300000, onLog } = opts;
    return new Promise<RunSubprocessResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        // 逐行缓冲在「字节」层面(Buffer),按 \n 切行后整行智能解码——
        // 既避免 chunk 边界切断多字节字符,又能对整行判定 UTF-8/GBK。
        let outByteBuf = Buffer.alloc(0);
        let errByteBuf = Buffer.alloc(0);

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

        /** 累积字节缓冲,按行切分→智能解码→并入完整输出 + 逐行转发 onLog */
        const feed = (chunk: Buffer, isErr: boolean): void => {
            let buf = Buffer.concat([isErr ? errByteBuf : outByteBuf, chunk]);
            let nl: number;
            while ((nl = buf.indexOf(0x0a)) >= 0) {
                let lineBuf = buf.subarray(0, nl);
                // 去掉行尾的 \r(Windows CRLF)
                if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
                    lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
                }
                const line = decodeSmart(lineBuf);
                if (isErr) {
                    stderr += line + '\n';
                } else {
                    stdout += line + '\n';
                }
                if (onLog && line) {
                    onLog(line);
                }
                buf = buf.subarray(nl + 1);
            }
            if (isErr) {
                errByteBuf = buf;
            } else {
                outByteBuf = buf;
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
            // flush 残留的不完整行(无结尾换行)
            if (outByteBuf.length > 0) {
                const line = decodeSmart(outByteBuf);
                stdout += line;
                if (onLog && line.trim()) {
                    onLog(line);
                }
            }
            if (errByteBuf.length > 0) {
                const line = decodeSmart(errByteBuf);
                stderr += line;
                if (onLog && line.trim()) {
                    onLog(line);
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
