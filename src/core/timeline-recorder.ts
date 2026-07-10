// 请求时间线记录器(纯 fs / 零 Electron / 零 Playwright 依赖):供录制端(CDP Network)与
// 回放端(Playwright context.on)共用同一套 JSONL 写入与 entry 形状,保证两端记录格式逐字一致。
//
// 与 request-rewrite.ts 同为「两端共享的纯逻辑」模块。这是「只记录不修改」支路的落盘层:
// 每个请求写两行——请求到达时落 kind:'request'、完成时落 kind:'response',同 id 关联,
// 事后按 id join 即得「请求+响应」完整交换。
//
// 铁律:记录失败绝不影响录制/回放主流程——append 出错即熔断(disabled),后续静默不写不抛。
// 铁律:请求 body 完整记录,不做人为截断(调用方用 CDP getRequestPostData / Playwright postData 取完整 body)。
import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp } from './request-rewrite';
import { logInfo, logError } from './logger';

export type TimelinePhase = 'record' | 'replay';
export type TimelineKind = 'request' | 'response';

/** 时间线单条记录(两端统一形状) */
export interface TimelineEntry {
    /** ISO 时间戳(recorder 内部打) */
    t: string;
    /** 来源端(构造时注入) */
    phase: TimelinePhase;
    /** 请求行 or 响应行 */
    kind: TimelineKind;
    /** 请求↔响应关联 id(record 端=CDP requestId;replay 端=自增计数) */
    id: string;
    method: string;
    url: string;
    // --- kind='request' 专属 ---
    reqHeaders?: Record<string, string>;
    /** 完整请求 body(禁止截断);includeBody=false 或无 body 时省略 */
    reqBody?: string;
    // --- kind='response' 专属 ---
    status?: number;
    /** 请求发出到完成的耗时(毫秒) */
    timingMs?: number;
    respHeaders?: Record<string, string>;
    mimeType?: string;
    /** 失败时的 errorText */
    error?: string;
}

/** writeRequest 入参(业务字段;t/phase/kind 由 recorder 内部补) */
export interface RequestFields {
    id: string;
    method: string;
    url: string;
    reqHeaders?: Record<string, string>;
    reqBody?: string;
}

/** writeResponse 入参 */
export interface ResponseFields {
    id: string;
    method: string;
    url: string;
    status?: number;
    timingMs?: number;
    respHeaders?: Record<string, string>;
    mimeType?: string;
    error?: string;
}

/**
 * 产出毫秒级文件名戳 `YYYYMMDD-HHmmssSSS`。
 * 项目既有 timestamp() 只到秒——两端写同一 timelines/ 目录,同秒开一次录制 + 一次回放会撞名混行,
 * 故这里用毫秒级 + phase 入名规避(运行时代码,可用 Date)。
 */
function fileStamp(): string {
    const d = new Date();
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
    return (
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`
    );
}

export class TimelineRecorder {
    /** 已写条数(日志/自检用) */
    private written = 0;
    private readonly filePath: string;
    private readonly phase: TimelinePhase;
    private urlRe: RegExp | null;
    /** 目录是否已建(懒建,仿 DownloadManager) */
    private ready = false;
    /** 熔断:一旦落盘失败即置位,后续静默不写不抛,不拖垮主流程 */
    private disabled = false;

    /**
     * @param dir        输出目录(timelines/)
     * @param phase      来源端,进 entry 与文件名
     * @param urlPattern 只记录命中该 CDP glob 的 URL;缺省/空 → 记录所有请求
     */
    constructor(dir: string, phase: TimelinePhase, urlPattern?: string) {
        this.filePath = path.join(dir, `timeline-${phase}-${fileStamp()}.jsonl`);
        this.phase = phase;
        this.urlRe = compilePattern(urlPattern);
    }

    /** 已写条数 */
    get count(): number {
        return this.written;
    }

    /** 当前时间线文件绝对路径 */
    get file(): string {
        return this.filePath;
    }

    /** URL 是否应记录:无 pattern → 恒 true;非法 pattern 已在编译期退化为 null(恒 true) */
    matches(url: string): boolean {
        if (!this.urlRe) {
            return true;
        }
        try {
            return this.urlRe.test(url);
        } catch {
            return true; // 兜底放行(与 matchRule 对非法 pattern 的容错一致)
        }
    }

    /** 更新 urlPattern(录制端热更新改 pattern 时不换文件) */
    setPattern(urlPattern?: string): void {
        this.urlRe = compilePattern(urlPattern);
    }

    /** 写一条请求行 */
    writeRequest(f: RequestFields): void {
        this.append({
            t: new Date().toISOString(),
            phase: this.phase,
            kind: 'request',
            id: f.id,
            method: f.method,
            url: f.url,
            reqHeaders: f.reqHeaders,
            reqBody: f.reqBody,
        });
    }

    /** 写一条响应行 */
    writeResponse(f: ResponseFields): void {
        this.append({
            t: new Date().toISOString(),
            phase: this.phase,
            kind: 'response',
            id: f.id,
            method: f.method,
            url: f.url,
            status: f.status,
            timingMs: f.timingMs,
            respHeaders: f.respHeaders,
            mimeType: f.mimeType,
            error: f.error,
        });
    }

    /** JSONL 追加写:懒建目录 + 一行一条;出错即熔断,永不抛出 */
    private append(entry: TimelineEntry): void {
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
            logError(`请求时间线记录:落盘失败,已停止记录(不影响录制/回放):${message}`);
        }
    }
}

/** 把 urlPattern 编译成正则;空/缺省 → null(表示恒匹配);非法 → null(退化为恒匹配) */
function compilePattern(urlPattern?: string): RegExp | null {
    if (!urlPattern || urlPattern === '*') {
        return null; // 记录所有请求
    }
    try {
        return globToRegExp(urlPattern);
    } catch {
        logInfo(`请求时间线记录:urlPattern 非法「${urlPattern}」,改为记录所有请求。`);
        return null;
    }
}
