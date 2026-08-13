// list-detail「数据补全(增量重抓)」的快照读写层(纯 fs / 零 Electron / 零 Playwright 依赖)。
//
// 背景:list-detail 阶段二要逐个 `page.goto(detailUrl)` 进详情页,列表项动辄上百,总有几个详情页
// 加载失败 → 那些行详情字段为空。而 rows 只活在内存与最终 xlsx 里,中途停止/回放失败都不回传
// rows(macro-runner 的 cancelled / error 分支)—— 最需要补抓的场景恰好数据丢得最干净。
//
// 于是:阶段二每抓完一项就把「该项详情侧的字段值 + 抓取结论」追加一行到 resume/<key>.jsonl;
// 下次勾「补抓」再跑时,阶段一照常重跑(detailUrl 清单只能从列表页得到、顺便刷新列表字段),
// 阶段二对每个 detailUrl 查快照 —— 上次已成功的直接复用其详情值、**不再导航**,其余照常抓。
// 产出因此天然是「完整合并结果」且顺序天然正确,无需任何合并/去重逻辑。
//
// 关键约定:
// - **只存详情侧的值**,不存整行。于是「列表字段用本次新值」不是选择而是唯一可能的结果;
//   1:N 展开的行数由快照决定(没重访详情页就无从得知子项数,沿用上次观测值);
//   改列表侧字段(含 label/order/hidden)不作废快照。
// - **写恒开、读按开关**(reuse):提取端无条件 get/record,「这次要不要复用」收口在本模块。
// - **写模式按 reuse 分叉**:全量跑(reuse=false)先 truncate——这一轮会重抓每一项、旧条目全被取代,
//   追加只会让同一 u 攒重复行;补抓跑(reuse=true)才 append,只追加本轮实抓的少数 miss 项。
//
// 铁律(同 timeline-recorder / record-body-index):写失败即熔断(disabled),后续静默不写不抛,
// 绝不拖垮回放主流程;目录懒建,非 list-detail 的宏连目录都不会创建。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileStamp } from './timeline-recorder';
import { logError, logInfo } from './logger';
import type { ExtractConfig, ExtractRow, ListDetailExtractConfig } from './macro-types';

/** 单项抓取结论:ok=抓到值 / empty=详情字段全空(含子列表 0 命中) / failed=抛错(超时、页面关闭等) */
export type ResumeStatus = 'ok' | 'empty' | 'failed';

/** 快照文件头行(首行);v/sig 不符即整份作废 */
interface SnapshotHeader {
    kind: 'resume-snapshot';
    v: number;
    /** 提取规则「详情侧」签名,见 resumeSignature */
    sig: string;
    /** 仅作信息(人工排查用),不参与判定——宏改名/移动不该白丢快照 */
    macro?: string;
    macroPath?: string;
}

/** 快照数据行:一个 detailUrl 一条 */
interface SnapshotEntry {
    /** 唯一键:绝对化后的详情页 URL */
    u: string;
    s: ResumeStatus;
    /** 仅 detailFields 的值,按 config.detailFields 顺序(保 key 序);empty/failed 为 [] */
    d: ExtractRow[];
    /** ISO 时间戳(内部打) */
    t: string;
}

/** 快照当前版本号 */
const SNAPSHOT_VERSION = 1;

/** 单次运行追加条数上限(防异常场景刷爆磁盘);达上限停写并告警一次 */
const DEFAULT_MAX_ENTRIES = 50000;

/**
 * 补抓快照读写器。阶段二逐项 get / record;所有方法不抛(内部熔断)。
 */
export interface ResumeStore {
    /** 上次成功抓到的「详情侧字段值」逐行数组;未抓过 / 非 ok / 未开复用 → null */
    get(detailUrl: string): ExtractRow[] | null;
    /** 记录一项结果并增量落盘(每项一行 JSONL) */
    record(detailUrl: string, status: ResumeStatus, detailValues: ExtractRow[]): void;
    /** 本次运行的中文统计(复用/实抓/各结论计数),供回放结束时打日志 */
    summary(): string;
    /** 快照文件绝对路径(供日志提示用户位置) */
    readonly file: string;
    /** 是否开启了复用(供调用方打「补抓模式 / 仅记录」日志) */
    readonly reuseEnabled: boolean;
}

/**
 * 由提取规则算「详情侧」签名:只纳入影响详情字段取值的东西 ——
 * mode、trim 后的 detailListSelector、detailFields 各项的 {name, selector, type, attr, transform, default}。
 *
 * **排除** label / order / hidden(只影响出表,改了不该作废几百项快照);
 * **排除** fields / listSelector / detailLinkField(列表侧每次重采,改了不影响复用正确性;
 * 其中 detailLinkField 改了会让 u 变形 → 自然全 miss,不会污染数据)。
 */
export function resumeSignature(config: ExtractConfig): string {
    const c = config as Partial<ListDetailExtractConfig>;
    const payload = {
        mode: config.mode,
        detailListSelector:
            typeof c.detailListSelector === 'string' ? c.detailListSelector.trim() : '',
        detailFields: (c.detailFields ?? []).map((f) => ({
            name: f.name,
            selector: f.selector,
            type: f.type,
            attr: f.attr ?? '',
            transform: f.transform ?? [],
            default: f.default ?? '',
        })),
    };
    return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
}

/** createResumeStore 入参 */
export interface CreateResumeStoreOptions {
    /** 快照目录(由主进程传入,core 层不解析目录) */
    dir: string;
    /** 文件名主键(由主进程按宏文件路径/宏名推导并消毒) */
    key: string;
    /** 本宏的提取规则;非 list-detail 或无 detailFields → 本函数返回 null */
    config: ExtractConfig | undefined;
    /** 是否复用快照跳过已成功项(false = 只记不复用) */
    reuse: boolean;
    /** 宏名(仅写进头行作信息) */
    macroName?: string;
    /** 宏文件路径(仅写进头行作信息) */
    macroPath?: string;
    /** 条数上限,缺省 50000 */
    maxEntries?: number;
}

/**
 * 建快照读写器。**非 list-detail 或 detailFields 为空 → 返回 null**,调用方据此完全不接线
 * (不建目录、不写文件,零足迹)。
 */
export function createResumeStore(opts: CreateResumeStoreOptions): ResumeStore | null {
    const config = opts.config;
    if (!config || config.mode !== 'list-detail') {
        return null; // 只有 list-detail 有「逐项进详情页」这件事可补
    }
    if (!Array.isArray(config.detailFields) || config.detailFields.length === 0) {
        return null; // 无详情字段 = 无可补抓之物
    }
    return new FileResumeStore(opts, config);
}

class FileResumeStore implements ResumeStore {
    readonly file: string;
    readonly reuseEnabled: boolean;

    private readonly header: SnapshotHeader;
    private readonly maxEntries: number;
    /** 上轮(及本轮已记录)的条目;键 = detailUrl,后写覆盖先写 */
    private readonly entries = new Map<string, SnapshotEntry>();
    /** 上轮可复用(status=ok)的条目数,用于「快照有 ok 但本轮复用 0 项」的告警 */
    private readonly loadedOkCount: number;
    /** 构造时载入的旧条目(去重后、保序)的副本;首次写盘时原样写回,保证旧记录不因本轮而丢 */
    private preserved: SnapshotEntry[] = [];

    /** 首次写盘前需要先轮转旧文件(sig 不符)—— 懒到第一次 record 时才做 */
    private pendingRotate = false;

    private ready = false;
    private disabled = false;
    private warnedMax = false;

    private reused = 0;
    private fetched = 0;
    private okCount = 0;
    private emptyCount = 0;
    private failedCount = 0;

    constructor(opts: CreateResumeStoreOptions, config: ListDetailExtractConfig) {
        this.file = path.join(opts.dir, `${opts.key}.jsonl`);
        this.reuseEnabled = opts.reuse;
        this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
        this.header = {
            kind: 'resume-snapshot',
            v: SNAPSHOT_VERSION,
            sig: resumeSignature(config),
            macro: opts.macroName,
            macroPath: opts.macroPath,
        };

        // **无论是否复用都要先读旧快照。** 全量跑虽然会重抓每一项,但旧记录必须保留 ——
        // 否则「忘勾补抓又跑了一次、而且中途还停了」会把上一轮辛苦抓到的成功记录一起削掉,
        // 而"中途停止"恰恰是本功能最该守住的场景。旧条目在首次写盘时被原样写回(见 compact),
        // 故文件稳定在「键数 + 本轮变更数」量级,不会无界增长。
        // 头行非法 / 版本或签名不符 → 视为无快照 + 标记轮转(旧文件留 .bak 供人工回捞)。
        const loaded = this.load(opts.reuse);
        this.pendingRotate = loaded.shouldRotate;
        // 复用告警只对补抓模式有意义(全量跑本就不复用,不该提示"补抓未生效")
        this.loadedOkCount = opts.reuse ? loaded.okCount : 0;
        this.preserved = [...this.entries.values()];
    }

    /**
     * 读旧快照建索引。读取全部宽容(照 loadMacroCaptures 的「坏 JSON 不抛」):
     * 文件不存在 → 无快照且无需轮转;头行非法 / v、sig 不符 → 无快照且需轮转;单行坏 JSON → 跳过该行。
     */
    private load(reuse: boolean): { usable: boolean; shouldRotate: boolean; okCount: number } {
        let content: string;
        try {
            content = fs.readFileSync(this.file, 'utf-8');
        } catch {
            return { usable: false, shouldRotate: false, okCount: 0 }; // 不存在/不可读:当无快照
        }
        const lines = content.split('\n').filter((l) => l.trim());
        if (lines.length === 0) {
            return { usable: false, shouldRotate: false, okCount: 0 }; // 空文件:直接重写,无需轮转
        }
        let head: unknown;
        try {
            head = JSON.parse(lines[0]);
        } catch {
            logInfo('补抓快照:首行不是合法 JSON,视为无快照并轮转旧文件,本次将全量抓取。');
            return { usable: false, shouldRotate: true, okCount: 0 };
        }
        const h = head as Partial<SnapshotHeader>;
        if (h.kind !== 'resume-snapshot' || h.v !== SNAPSHOT_VERSION) {
            logInfo('补抓快照:文件类型或版本不符,视为无快照并轮转旧文件,本次将全量抓取。');
            return { usable: false, shouldRotate: true, okCount: 0 };
        }
        if (h.sig !== this.header.sig) {
            logInfo(
                '补抓快照:提取规则的详情侧已变更(选择器/清洗链/字段等),旧快照作废并轮转,本次将全量抓取。'
            );
            return { usable: false, shouldRotate: true, okCount: 0 };
        }
        let okCount = 0;
        for (let i = 1; i < lines.length; i += 1) {
            try {
                const e = JSON.parse(lines[i]) as Partial<SnapshotEntry>;
                if (typeof e.u !== 'string' || !e.u || typeof e.s !== 'string') {
                    continue; // 结构不符:跳过该行
                }
                const entry: SnapshotEntry = {
                    u: e.u,
                    s: e.s as ResumeStatus,
                    d: Array.isArray(e.d) ? (e.d as ExtractRow[]) : [],
                    t: typeof e.t === 'string' ? e.t : '',
                };
                this.entries.set(entry.u, entry); // 同一 u 后写覆盖先写(上次 failed、这次 ok)
            } catch {
                /* 单行坏 JSON:跳过,其余照用 */
            }
        }
        for (const e of this.entries.values()) {
            if (e.s === 'ok') {
                okCount += 1;
            }
        }
        // 全量跑时不提"可复用"(本轮不会复用),只说保留了多少旧记录,免得日志误导
        logInfo(
            reuse
                ? `补抓快照:已载入 ${this.entries.size} 条记录(其中可复用 ${okCount} 条)。`
                : `补抓快照:本次全量抓取,已保留上轮 ${this.entries.size} 条记录(不复用,仅防中途中断时丢失)。`
        );
        return { usable: true, shouldRotate: false, okCount };
    }

    get(detailUrl: string): ExtractRow[] | null {
        if (!this.reuseEnabled || !detailUrl) {
            return null;
        }
        const hit = this.entries.get(detailUrl);
        if (!hit || hit.s !== 'ok') {
            return null; // 未抓过 / 上次为空或失败 → 本次重抓
        }
        this.reused += 1;
        return hit.d;
    }

    record(detailUrl: string, status: ResumeStatus, detailValues: ExtractRow[]): void {
        if (!detailUrl) {
            return; // 无键(列表项没有详情链接):不记录,行为与现状一致
        }
        this.fetched += 1;
        if (status === 'ok') {
            this.okCount += 1;
        } else if (status === 'empty') {
            this.emptyCount += 1;
        } else {
            this.failedCount += 1;
        }
        const entry: SnapshotEntry = {
            u: detailUrl,
            s: status,
            d: status === 'ok' ? detailValues : [],
            t: new Date().toISOString(),
        };
        this.entries.set(detailUrl, entry); // 同一 run 内同 URL 重复出现时也保持最新
        this.append(entry);
    }

    summary(): string {
        const mode = this.reuseEnabled ? '补抓模式' : '仅记录(未开复用)';
        const parts = [
            `${mode}:复用 ${this.reused} 项`,
            `实抓 ${this.fetched} 项`,
            `其中成功 ${this.okCount} / 空 ${this.emptyCount} / 失败 ${this.failedCount}`,
        ];
        let text = `补抓快照统计 —— ${parts.join(',')}。快照:${this.file}`;
        // 快照里明明有可复用条目却一项都没命中:多半是详情链接不稳定(带随机参数/域名变了)
        if (this.reuseEnabled && this.loadedOkCount > 0 && this.reused === 0) {
            text +=
                `\n补抓未生效:快照有 ${this.loadedOkCount} 条可复用记录,但本次一项都没匹配上 ——` +
                '详情链接可能带随机参数或域名已变化,请检查详情链接字段。';
        }
        if (this.failedCount > 0 || this.emptyCount > 0) {
            text += '\n提示:仍有未抓到的项,勾选顶栏「♻️ 补抓」再运行一次即可只补这些项。';
        }
        return text;
    }

    /** JSONL 追加写:懒建目录 / 按需轮转与重写头行 / 一行一条;出错即熔断,永不抛出 */
    private append(entry: SnapshotEntry): void {
        if (this.disabled) {
            return;
        }
        if (this.entries.size > this.maxEntries) {
            if (!this.warnedMax) {
                this.warnedMax = true;
                this.disabled = true;
                logError(
                    `补抓快照:条目数超过上限 ${this.maxEntries},已停止记录(不影响本次回放)。`
                );
            }
            return;
        }
        try {
            if (!this.ready) {
                fs.mkdirSync(path.dirname(this.file), { recursive: true });
                if (this.pendingRotate) {
                    this.rotate();
                }
                this.compact();
                this.ready = true;
            }
            fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf-8');
        } catch (err) {
            this.disabled = true; // 熔断:一次即止,不再重复报错、不影响主流程
            const message = err instanceof Error ? err.message : String(err);
            logError(`补抓快照:落盘失败,已停止记录(不影响回放):${message}`);
        }
    }

    /**
     * 首次写盘前压实:重写成「头行 + 去重后的旧条目」,之后本轮的新结果 append 在后面。
     *
     * 为什么压实而不是简单 truncate:truncate 会丢掉上轮记录,于是「忘勾补抓又跑一次、中途还停了」
     * 就把上一轮抓到的成功项一起削掉(实测第 1 轮 5 项、第 2 轮跑 2 项就停 → 只剩 2 项可复用)。
     * 为什么也不是纯 append:同一 u 会逐轮攒重复行,文件无界增长。
     * 压实两头都占:旧记录保留,文件稳定在「键数 + 本轮变更数」量级(读取时同键后写胜)。
     *
     * 经 tmp + rename 落盘:同盘 rename 是原子的,压实中途崩溃也不会把旧数据写坏成半截文件。
     */
    private compact(): void {
        const lines = [JSON.stringify(this.header), ...this.preserved.map((e) => JSON.stringify(e))];
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf-8');
        fs.renameSync(tmp, this.file);
    }

    /** 把作废的旧快照改名留档(供人工回捞);改名失败则不阻塞——后续压实会直接覆盖 */
    private rotate(): void {
        this.pendingRotate = false;
        const bak = `${this.file}-${fileStamp()}.bak`;
        try {
            fs.renameSync(this.file, bak);
            logInfo(`补抓快照:旧快照已留档 ${bak}(可自行删除)。`);
        } catch {
            /* 改名失败(占用/权限):不阻塞,后续 truncate 直接覆盖 */
        }
    }
}
