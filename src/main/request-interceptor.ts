// 录制端请求改写器:通过 Chrome DevTools Protocol(CDP)的 Fetch 域,
// 在录制 webview 的请求发出前暂停、按规则改写 POST body、再放行。
//
// 为何用 CDP:Electron 的 session.webRequest 只能改 URL/请求头,**改不了 POST body**
// (uploadData 只读)。要在录制端改请求体,唯一路径是 webContents.debugger 挂 Fetch 域。
//
// 已知限制:CDP debugger 独占——用户手动打开该 webview 的 DevTools 会顶掉本拦截器
// (触发 detach,记日志提示)。
import fs from 'node:fs';
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

export class RequestInterceptor {
    private readonly configPath: string;
    private wc: WebContents | null = null;
    private config: RequestRulesConfig = { enabled: false, rules: [] };
    /** 当前已下发给 Fetch.enable 的 urlPattern 集合签名,用于判断是否需要重新 enable */
    private enabledKey = '';
    /** 是否正在拦截(已 Fetch.enable) */
    private intercepting = false;
    /** 规则文件监听回调引用,detach 时解除 */
    private watchListener: (() => void) | null = null;

    constructor(configPath: string) {
        this.configPath = configPath;
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
            }
        });
        wc.debugger.on('detach', (_event, reason) => {
            this.intercepting = false;
            logError(`请求改写器:调试器已分离(${reason});如需继续改写请关闭开发者工具并重开页面。`);
        });

        // 初次加载配置(文件不存在会自动生成 inert 模板)+ 按需启用
        this.config = loadRequestRules(this.configPath);
        void this.applyPatterns();

        // 监听规则文件变化:改了 enabled / 规则即时生效,无需重启
        const listener = (): void => {
            this.config = loadRequestRules(this.configPath);
            void this.applyPatterns();
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
        if (!wc) {
            return;
        }
        try {
            if (wc.debugger.isAttached()) {
                wc.debugger.sendCommand('Fetch.disable').catch(() => undefined);
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
