// 录制端请求改写器:通过 Chrome DevTools Protocol(CDP)的 Fetch 域,
// 在录制 webview 的请求发出前暂停、按规则改写 POST body、再放行。
//
// 为何用 CDP:Electron 的 session.webRequest 只能改 URL/请求头,**改不了 POST body**
// (uploadData 只读)。要在录制端改请求体,唯一路径是 webContents.debugger 挂 Fetch 域。
//
// 已知限制:CDP debugger 独占——用户手动打开该 webview 的 DevTools 会顶掉本拦截器
// (触发 detach,记日志提示)。
import fs from 'node:fs';
import path from 'node:path';
import type { WebContents } from 'electron';
import type { RequestRule, RequestRulesConfig } from '../core/macro-types';
import { loadRequestRules } from '../storage/request-rules-store';
import { logInfo, logError } from '../core/logger';
import {
    matchRule,
    decideBodyType,
    rewritePostBody,
    headerValue,
} from '../core/request-rewrite';
import { TimelineRecorder } from '../core/timeline-recorder';

// 改写纯逻辑已抽到 core 的 request-rewrite(与回放端 Playwright route 共用同一套函数)。
// 这里再导出旧的三个纯函数,保持本模块导出面不变(scripts/verify-request-rewrite.mjs 仍从
// dist/main/request-interceptor.js 取用,零改动即可通过)。
export { globToRegExp, decideBodyType, rewritePostBody } from '../core/request-rewrite';

/** Fetch.requestPaused 事件里的请求形状(只取用到的字段) */
interface PausedRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    hasPostData?: boolean;
    postData?: string;
}

/** Network.requestWillBeSent 事件里的请求形状(只取用到的字段) */
interface NetworkRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    hasPostData?: boolean;
    postData?: string;
}

/** 记录支路的在途请求状态(按 CDP requestId 关联 requestWillBeSent→response→finished/failed) */
interface PendingRecord {
    id: string;
    url: string;
    method: string;
    /** requestWillBeSent 的单调时间戳(秒),用于算耗时 */
    startTs: number;
    status?: number;
    mimeType?: string;
    respHeaders?: Record<string, string>;
}

export class RequestInterceptor {
    private readonly configPath: string;
    /** 时间线记录输出目录(record 支路);缺省用 configPath 同级的 timelines */
    private readonly timelinesDir: string;
    private wc: WebContents | null = null;
    private config: RequestRulesConfig = { enabled: false, rules: [] };
    /** 当前已下发给 Fetch.enable 的 urlPattern 集合签名,用于判断是否需要重新 enable */
    private enabledKey = '';
    /** 是否正在拦截(已 Fetch.enable) */
    private intercepting = false;
    /** 规则文件监听回调引用,detach 时解除 */
    private watchListener: (() => void) | null = null;

    // --- 只记录不修改支路(独立于上面的改写状态) ---
    /** 时间线记录器;record.enabled 时创建 */
    private recorder: TimelineRecorder | null = null;
    /** 是否正在记录(已 Network.enable) */
    private recording = false;
    /** 当前 record 段配置签名,去重避免每次文件 tick 都重建记录器/换文件 */
    private recordKey = '';
    /** 在途请求(按 CDP requestId 关联请求行与响应行) */
    private readonly pending = new Map<string, PendingRecord>();

    constructor(configPath: string, timelinesDir?: string) {
        this.configPath = configPath;
        this.timelinesDir = timelinesDir ?? path.join(path.dirname(configPath), 'timelines');
    }

    /** 挂载到录制 webview 的 webContents:attach debugger + 按规则启用 Fetch 拦截 */
    attach(wc: WebContents): void {
        this.wc = wc;
        try {
            if (!wc.debugger.isAttached()) {
                wc.debugger.attach('1.3');
            }
        } catch (err) {
            // DevTools 已开等场景会抢占 debugger;记告警,不致命(录制照常,只是不改写)
            logError(`请求改写器:无法挂载调试器(可能已打开开发者工具),本次不拦截:${(err as Error).message}`);
            this.wc = null;
            return;
        }

        wc.debugger.on('message', (_event, method, params) => {
            if (method === 'Fetch.requestPaused') {
                void this.onRequestPaused(params as { requestId: string; request: PausedRequest });
            } else if (method.startsWith('Network.')) {
                // 只记录不修改支路:被动观测 Network 域事件(不暂停请求)
                this.onNetworkEvent(method, params as Record<string, unknown>);
            }
        });
        wc.debugger.on('detach', (_event, reason) => {
            this.intercepting = false;
            this.recording = false;
            logError(`请求改写器:调试器已分离(${reason});如需继续改写请关闭开发者工具并重开页面。`);
        });

        // 初次加载配置(文件不存在会自动生成 inert 模板)+ 按需启用(改写 + 记录两支路)
        this.config = loadRequestRules(this.configPath);
        void this.applyPatterns();
        void this.applyRecording();

        // 监听规则文件变化:改了 enabled / 规则 / record 段即时生效,无需重启
        const listener = (): void => {
            this.config = loadRequestRules(this.configPath);
            void this.applyPatterns();
            void this.applyRecording();
        };
        this.watchListener = listener;
        try {
            fs.watchFile(this.configPath, { interval: 1000 }, listener);
        } catch {
            /* 监听失败不致命,仅失去热更新 */
        }
    }

    /** 卸载:关闭 Fetch、解除文件监听、分离调试器(各自 try/catch) */
    detach(): void {
        if (this.watchListener) {
            try {
                fs.unwatchFile(this.configPath, this.watchListener);
            } catch {
                /* 忽略 */
            }
            this.watchListener = null;
        }
        const wc = this.wc;
        this.wc = null;
        this.intercepting = false;
        // 记录支路收尾:关 Network 观测、清记录器与在途请求(debugger.detach 本会全拆,这里显式防泄漏)
        const wasRecording = this.recording;
        this.recording = false;
        this.recorder = null;
        this.recordKey = '';
        this.pending.clear();
        if (!wc) {
            return;
        }
        try {
            if (wc.debugger.isAttached()) {
                wc.debugger.sendCommand('Fetch.disable').catch(() => undefined);
                if (wasRecording) {
                    wc.debugger.sendCommand('Network.disable').catch(() => undefined);
                }
                wc.debugger.detach();
            }
        } catch {
            /* 已分离等异常忽略 */
        }
    }

    /** 依据当前配置启用/更新/关闭 Fetch 拦截(仅对命中规则 urlPattern 的请求暂停) */
    private async applyPatterns(): Promise<void> {
        const wc = this.wc;
        if (!wc || !wc.debugger.isAttached()) {
            return;
        }
        const active = this.config.enabled && this.config.rules.length > 0;
        if (!active) {
            if (this.intercepting) {
                await wc.debugger.sendCommand('Fetch.disable').catch(() => undefined);
                this.intercepting = false;
                logInfo('请求改写器:已停用(enabled=false 或无规则)。');
            }
            this.enabledKey = '';
            return;
        }
        const patterns = this.config.rules.map((r) => ({
            urlPattern: r.urlPattern,
            requestStage: 'Request' as const,
        }));
        const key = JSON.stringify(patterns.map((p) => p.urlPattern).sort());
        if (this.intercepting && key === this.enabledKey) {
            return; // 规则 URL 集合未变,无需重新下发
        }
        try {
            await wc.debugger.sendCommand('Fetch.enable', { patterns });
            this.intercepting = true;
            this.enabledKey = key;
            logInfo(
                `请求改写器:已启用,共 ${this.config.rules.length} 条规则,` +
                    `匹配 URL:${this.config.rules.map((r) => r.urlPattern).join(' | ')}`
            );
        } catch (err) {
            logError(`请求改写器:启用 Fetch 失败:${(err as Error).message}`);
        }
    }

    /**
     * 依据当前配置启用/更新/关闭「只记录不修改」支路(Network 域被动观测,不暂停请求)。
     * Network 与 Fetch 是独立 CDP 域,可在同一 debugger 会话共存;记录与改写互不影响。
     */
    private async applyRecording(): Promise<void> {
        const wc = this.wc;
        if (!wc || !wc.debugger.isAttached()) {
            return;
        }
        const rec = this.config.record;
        const want = rec?.enabled === true;
        const key = JSON.stringify(rec ?? null);
        if (want && !this.recording) {
            try {
                // Network.enable 无 URL 过滤能力(不像 Fetch patterns),全量启用、过滤靠 recorder.matches
                await wc.debugger.sendCommand('Network.enable');
                this.recorder = new TimelineRecorder(this.timelinesDir, 'record', rec?.urlPattern);
                this.recording = true;
                this.recordKey = key;
                logInfo(
                    `请求记录:已启用(记录所有请求到时间线,不改写),匹配 URL:${rec?.urlPattern || '全部'};` +
                        `输出:${this.recorder.file}`
                );
            } catch (err) {
                logError(`请求记录:启用 Network 失败:${(err as Error).message}`);
            }
        } else if (!want && this.recording) {
            await wc.debugger.sendCommand('Network.disable').catch(() => undefined);
            this.recording = false;
            this.recorder = null;
            this.recordKey = '';
            this.pending.clear();
            logInfo('请求记录:已停用。');
        } else if (want && this.recording && key !== this.recordKey) {
            // 仅 urlPattern / includeBody 变化:更新 pattern,不换文件
            this.recorder?.setPattern(rec?.urlPattern);
            this.recordKey = key;
        }
    }

    /** 分发 Network 域事件到记录支路(requestWillBeSent / responseReceived / loadingFinished / loadingFailed) */
    private onNetworkEvent(method: string, params: Record<string, unknown>): void {
        if (!this.recorder) {
            return;
        }
        try {
            if (method === 'Network.requestWillBeSent') {
                const p = params as unknown as {
                    requestId: string;
                    request: NetworkRequest;
                    timestamp: number;
                };
                if (!this.recorder.matches(p.request.url)) {
                    return;
                }
                this.pending.set(p.requestId, {
                    id: p.requestId,
                    url: p.request.url,
                    method: p.request.method,
                    startTs: p.timestamp,
                });
                void this.emitRequestLine(p.requestId, p.request);
            } else if (method === 'Network.responseReceived') {
                const p = params as unknown as {
                    requestId: string;
                    response: { status: number; mimeType?: string; headers?: Record<string, string> };
                };
                const rec = this.pending.get(p.requestId);
                if (rec) {
                    rec.status = p.response.status;
                    rec.mimeType = p.response.mimeType;
                    rec.respHeaders = p.response.headers;
                }
            } else if (method === 'Network.loadingFinished') {
                const p = params as unknown as { requestId: string; timestamp: number };
                const rec = this.pending.get(p.requestId);
                if (rec) {
                    this.recorder.writeResponse({
                        id: rec.id,
                        method: rec.method,
                        url: rec.url,
                        status: rec.status,
                        timingMs: Math.round((p.timestamp - rec.startTs) * 1000),
                        respHeaders: rec.respHeaders,
                        mimeType: rec.mimeType,
                    });
                    this.pending.delete(p.requestId);
                }
            } else if (method === 'Network.loadingFailed') {
                const p = params as unknown as { requestId: string; errorText?: string };
                const rec = this.pending.get(p.requestId);
                if (rec) {
                    this.recorder.writeResponse({
                        id: rec.id,
                        method: rec.method,
                        url: rec.url,
                        status: rec.status,
                        error: p.errorText,
                    });
                    this.pending.delete(p.requestId);
                }
            }
        } catch (err) {
            // 记录支路出任何错都不得影响主流程
            logError(`请求记录:处理 Network 事件出错:${(err as Error).message}`);
        }
    }

    /**
     * 写一条请求行:includeBody 默认为真时,用 Network.getRequestPostData 取**完整** body
     * (遵守「禁止人为截断」铁律,不用事件里可能被截断的 request.postData)。
     */
    private async emitRequestLine(requestId: string, request: NetworkRequest): Promise<void> {
        const wc = this.wc;
        if (!wc || !this.recorder) {
            return;
        }
        let body: string | undefined;
        if (this.config.record?.includeBody !== false && request.hasPostData) {
            try {
                const res = (await wc.debugger.sendCommand('Network.getRequestPostData', {
                    requestId,
                })) as { postData?: string };
                body = typeof res.postData === 'string' ? res.postData : request.postData;
            } catch {
                // 无 body / 请求已失效:忽略,body 保持 undefined
                body = request.postData;
            }
        }
        this.recorder.writeRequest({
            id: requestId,
            method: request.method,
            url: request.url,
            reqHeaders: request.headers,
            reqBody: body,
        });
    }

    /** 处理一个被暂停的请求:命中规则的 POST 改写其 body,其余原样放行 */
    private async onRequestPaused(params: {
        requestId: string;
        request: PausedRequest;
    }): Promise<void> {
        const wc = this.wc;
        if (!wc || !wc.debugger.isAttached()) {
            return;
        }
        const { requestId, request } = params;
        try {
            const rule =
                request.method.toUpperCase() === 'POST'
                    ? matchRule(this.config.rules, request.url)
                    : null;
            if (rule) {
                const newBody = await this.rewriteBody(requestId, request, rule);
                if (newBody !== null) {
                    // CDP 要求 postData 为 base64;仅传 postData,Content-Length 由网络栈重算(同 Puppeteer)
                    await wc.debugger.sendCommand('Fetch.continueRequest', {
                        requestId,
                        postData: Buffer.from(newBody, 'utf8').toString('base64'),
                    });
                    return;
                }
            }
            // 未命中 / 非 POST / 改写失败:原样放行(每个暂停请求都必须 continue,否则页面卡死)
            await wc.debugger.sendCommand('Fetch.continueRequest', { requestId });
        } catch (err) {
            // 兜底:出任何错都尝试放行,避免卡死;放行也失败则记录
            logError(`请求改写器:处理请求出错:${(err as Error).message}`);
            try {
                await wc.debugger.sendCommand('Fetch.continueRequest', { requestId });
            } catch {
                /* 请求可能已失效,忽略 */
            }
        }
    }

    /**
     * 按规则改写 body,返回新 body 字符串;不需要/无法改写返回 null。
     * 取完整 body 用 Fetch.getRequestPostData(遵守「禁止人为截断」铁律,不用事件里可能被截断的 postData)。
     */
    private async rewriteBody(
        requestId: string,
        request: PausedRequest,
        rule: RequestRule
    ): Promise<string | null> {
        const wc = this.wc;
        if (!wc) {
            return null;
        }
        if (!request.hasPostData && !request.postData) {
            return null; // 无 body 可改
        }
        // 取完整原始 body
        let original = '';
        try {
            const res = (await wc.debugger.sendCommand('Fetch.getRequestPostData', {
                requestId,
            })) as { postData?: string };
            original = typeof res.postData === 'string' ? res.postData : request.postData ?? '';
        } catch {
            original = request.postData ?? '';
        }

        // 判定 body 类型:规则显式 > Content-Type 嗅探 > 内容嗅探
        const contentType = headerValue(request.headers, 'content-type');
        const bodyType = decideBodyType(rule, contentType, original);
        const setKeys = rule.set ? Object.keys(rule.set) : [];
        const appendKeys = rule.append ? Object.keys(rule.append) : [];
        const removeKeys = rule.remove ?? [];

        try {
            const out = rewritePostBody(original, bodyType, rule);
            if (out === null) {
                return null; // 规则没定义任何改写动作
            }
            logInfo(
                `请求改写器:已改写${bodyType === 'json' ? ' JSON ' : '表单'}请求体 [${request.url}];` +
                    `set=${setKeys.join(',') || '无'};append=${appendKeys.join(',') || '无'};` +
                    `remove=${removeKeys.join(',') || '无'}`
            );
            return out;
        } catch (err) {
            logError(`请求改写器:解析/改写 body 失败(按原样放行):${(err as Error).message}`);
            return null;
        }
    }
}
