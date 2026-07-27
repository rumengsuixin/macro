// record.saveBodies 的「精确索引」落盘层(纯 fs / 零 Electron / 零 Playwright 依赖)。
//
// saveBodies 把命中请求的请求体/响应体各写成独立文件(dumps/rec-<戳>-<requestId>-<req|res>.<ext>);
// 本模块在**同一 CDP 拦截回调里**同源再写一份 JSONL 索引(dumps/rec-index-<戳>.jsonl):每落一个 body 文件
// 追加一行,含该请求的 `networkId`(join 键)+ Fetch `requestId`(文件唯一标识)+ method/url + 文件名。
//
// join:`networkId` = CDP `Fetch.requestPaused.networkId`(== 同 session 的 `Network.requestWillBeSent.requestId`,
// 见 Playwright protocol),而 record 时间线(回放端已迁 CDP Network 域)的每条 `id` 也用同一个 networkId 值 ——
// 于是 **rec-index.networkId === timeline.id**,「哪个 body 文件属于哪个请求」可与 record 时间线精确 join;
// 同一 networkId 的多份 body(CDP Fetch 对一个网络请求可能拦多次)天然归并到同一条 record。
//
// 铁律(同 timeline-recorder):写失败即熔断(disabled),后续静默不写不抛,绝不拖垮回放主流程。
import fs from 'node:fs';
import path from 'node:path';
import { fileStamp } from './timeline-recorder';
import { logError } from './logger';

/** 精确索引单条记录 */
export interface RecordBodyIndexEntry {
    /** ISO 时间戳(内部打) */
    t: string;
    /** join 键:CDP networkId(== record 时间线的 id);缺省(拿不到 networkId)时省略 */
    networkId?: string;
    /** CDP Fetch requestId —— 串联同一请求请求/响应行的键、也进 body 文件名,保文件唯一(原样,不消毒) */
    requestId: string;
    /** 请求行 or 响应行 */
    kind: 'request' | 'response';
    method: string;
    url: string;
    /** 对应落盘 body 文件的 basename(与 dumps/ 下文件一一对应) */
    file: string;
    // --- kind='response' 专属 ---
    status?: number;
    mimeType?: string;
    /** 请求发出到响应落盘的耗时(毫秒);拿不到起始时刻则省略 */
    timingMs?: number;
}

/** writeRequest 入参 */
export interface RecordBodyRequestFields {
    requestId: string;
    networkId?: string;
    method: string;
    url: string;
    file: string;
}

/** writeResponse 入参 */
export interface RecordBodyResponseFields {
    requestId: string;
    networkId?: string;
    method: string;
    url: string;
    file: string;
    status?: number;
    mimeType?: string;
    timingMs?: number;
}

export class RecordBodyIndex {
    private readonly filePath: string;
    /** 已写条数(日志/自检用) */
    private written = 0;
    /** 目录是否已建(懒建,仿 TimelineRecorder) */
    private ready = false;
    /** 熔断:一旦落盘失败即置位,后续静默不写不抛,不拖垮主流程 */
    private disabled = false;

    /** @param dir 输出目录(与 body 文件同目录 dumps/) */
    constructor(dir: string) {
        this.filePath = path.join(dir, `rec-index-${fileStamp()}.jsonl`);
    }

    /** 已写条数 */
    get count(): number {
        return this.written;
    }

    /** 当前索引文件绝对路径 */
    get file(): string {
        return this.filePath;
    }

    /** 写一条请求行 */
    writeRequest(f: RecordBodyRequestFields): void {
        this.append({
            t: new Date().toISOString(),
            networkId: f.networkId,
            requestId: f.requestId,
            kind: 'request',
            method: f.method,
            url: f.url,
            file: f.file,
        });
    }

    /** 写一条响应行 */
    writeResponse(f: RecordBodyResponseFields): void {
        this.append({
            t: new Date().toISOString(),
            networkId: f.networkId,
            requestId: f.requestId,
            kind: 'response',
            method: f.method,
            url: f.url,
            file: f.file,
            status: f.status,
            mimeType: f.mimeType,
            timingMs: f.timingMs,
        });
    }

    /** JSONL 追加写:懒建目录 + 一行一条;出错即熔断,永不抛出 */
    private append(entry: RecordBodyIndexEntry): void {
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
            logError(`record 体索引:落盘失败,已停止记录(不影响回放):${message}`);
        }
    }
}
