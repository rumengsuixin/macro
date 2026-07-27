// JS Hook 探针的「落盘索引」层(纯 fs / 零 Electron / 零 Playwright 依赖)。
//
// jsHooks 支路在回放端向页面主世界注入 hook 脚本,拦截 fetch/XHR/标准加密库/自定义签名函数,抓
// 「明文入参 ↔ 密文出参 + 调用栈」经 exposeBinding 回传 Node;本模块把每次命中追加一行 JSONL 索引
// (dumps/jshook-index-<戳>.jsonl)。短明文/短密文内联进索引;超阈值或二进制的 payload 旁落独立
// 文件(dumps/jshook-<戳>-<seq>-<in|out>.<ext>,完整不截断),索引里存文件名引用。
//
// 铁律(同 timeline-recorder / record-body-index):写失败即熔断(disabled),后续静默不写不抛,
// 绝不拖垮回放主流程。
import fs from 'node:fs';
import path from 'node:path';
import { fileStamp } from './timeline-recorder';
import { logError } from './logger';

/** JS Hook 命中的一条索引记录 */
export interface JsHookIndexEntry {
    /** ISO 时间戳(内部打) */
    t: string;
    /** 被 hook 的 api 名:fetch|xhr|json|btoa|subtle.<method>|cryptojs.<method>|custom:<path> */
    api: string;
    /** 命中时页面 location.href */
    url: string;
    /** 明文入参:短则内联;长/二进制则省略(见 inputFile) */
    input?: string;
    /** input 为 base64 编码的二进制时标 'base64' */
    inputEnc?: 'base64';
    /** 明文入参旁落文件的 basename(内联时省略) */
    inputFile?: string;
    /** 密文/摘要出参:短则内联;长/二进制则省略(见 outputFile) */
    output?: string;
    /** output 为 base64 编码的二进制时标 'base64' */
    outputEnc?: 'base64';
    /** 密文出参旁落文件的 basename(内联时省略) */
    outputFile?: string;
    /** 调用栈(页面 new Error().stack,已剥离探针自身帧),供定位签名/加密函数在哪个 JS 文件哪行 */
    stack?: string;
}

/** writeEntry 入参(t 由内部补) */
export interface JsHookFields {
    api: string;
    url: string;
    input?: string;
    inputEnc?: 'base64';
    inputFile?: string;
    output?: string;
    outputEnc?: 'base64';
    outputFile?: string;
    stack?: string;
}

export class JsHookIndex {
    private readonly filePath: string;
    /** 已写条数(日志/自检用) */
    private written = 0;
    /** 目录是否已建(懒建,仿 RecordBodyIndex) */
    private ready = false;
    /** 熔断:一旦落盘失败即置位,后续静默不写不抛,不拖垮主流程 */
    private disabled = false;

    /** @param dir 输出目录(与旁落文件同目录 dumps/) */
    constructor(dir: string) {
        this.filePath = path.join(dir, `jshook-index-${fileStamp()}.jsonl`);
    }

    /** 已写条数 */
    get count(): number {
        return this.written;
    }

    /** 当前索引文件绝对路径 */
    get file(): string {
        return this.filePath;
    }

    /** 写一条命中记录 */
    writeEntry(f: JsHookFields): void {
        this.append({ t: new Date().toISOString(), ...f });
    }

    /** JSONL 追加写:懒建目录 + 一行一条;出错即熔断,永不抛出 */
    private append(entry: JsHookIndexEntry): void {
        if (this.disabled) {
            return;
        }
        try {
            if (!this.ready) {
                fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
                this.ready = true;
            }
            fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
            this.written += 1;
        } catch (err) {
            this.disabled = true; // 熔断:一次即止,不再重复报错、不影响主流程
            const message = err instanceof Error ? err.message : String(err);
            logError(`JS Hook 探针索引:落盘失败,已停止记录(不影响回放):${message}`);
        }
    }
}
