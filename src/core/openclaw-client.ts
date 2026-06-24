// OpenClaw Gateway 对接客户端(WebSocket + Ed25519 签名认证)。
// 参考实现:D:\git_object\aiAgentServicer 的 test_ws_send.js / src/oclaw-client.js。
//
// 用法(单次请求即用即走):
//   const client = new OpenclawClient();
//   await client.connect();
//   const text = await client.requestDraft(sessionKey, message, timeoutMs);
//   client.close();
//
// 配置自动读取 ~/.openclaw/openclaw.json(端口/token)与 identity/device.json(Ed25519 身份)。
import WebSocket from 'ws';
import { randomUUID, createPublicKey, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** OpenClaw 连接参数 */
export interface OpenclawConnConfig {
    /** 覆盖 WS 地址(默认 ws://127.0.0.1:{port}) */
    url?: string;
    /** 覆盖 gateway token(默认读 openclaw.json) */
    token?: string;
}

interface OpenclawIdentity {
    deviceId: string;
    publicKeyPem: string;
    privateKeyPem: string;
}

interface ResolvedConfig {
    url: string;
    token: string;
    identity: OpenclawIdentity;
}

const SCOPES = [
    'operator.admin',
    'operator.read',
    'operator.write',
    'operator.approvals',
    'operator.pairing',
];
const ROLE = 'operator';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** base64url 编码 */
function base64UrlEncode(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** 从 PEM 公钥取 Ed25519 原始 32 字节(去 SPKI 前缀) */
function publicKeyRaw(pem: string): Buffer {
    const spki = createPublicKey(pem).export({ type: 'spki', format: 'der' }) as Buffer;
    if (
        spki.length === ED25519_SPKI_PREFIX.length + 32 &&
        spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
        return spki.subarray(ED25519_SPKI_PREFIX.length);
    }
    return spki;
}

/** 用 Ed25519 私钥签名 payload,返回 base64url */
function signPayload(privPem: string, payload: string): string {
    const key = createPrivateKey(privPem);
    return base64UrlEncode(cryptoSign(null, Buffer.from(payload, 'utf8'), key));
}

/** 构造 v3 签名 payload(与 OpenClaw gateway 约定一致) */
function buildSigningPayload(args: {
    deviceId: string;
    role: string;
    scopes: string[];
    signedAtMs: number;
    token: string;
    nonce: string;
}): string {
    return [
        'v3',
        args.deviceId,
        'cli',
        'cli',
        args.role,
        args.scopes.join(','),
        String(args.signedAtMs),
        args.token ?? '',
        args.nonce,
        'win32',
        '',
    ].join('|');
}

/** 读取 ~/.openclaw 配置与身份 */
export function loadOpenclawConfig(override: OpenclawConnConfig = {}): ResolvedConfig {
    const home = os.homedir();
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    const identityPath = path.join(home, '.openclaw', 'identity', 'device.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as OpenclawIdentity;
    const port = config.gateway?.port ?? 18789;
    const token = override.token ?? config.gateway?.auth?.token;
    if (!token) {
        throw new Error('未找到 gateway.auth.token,请检查 ~/.openclaw/openclaw.json');
    }
    if (!identity.deviceId || !identity.privateKeyPem || !identity.publicKeyPem) {
        throw new Error('身份文件缺字段,请检查 ~/.openclaw/identity/device.json');
    }
    return {
        url: override.url ?? `ws://127.0.0.1:${port}`,
        token,
        identity,
    };
}

interface PendingReq {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

/** OpenClaw WebSocket 客户端(单连接,够本次请求用) */
export class OpenclawClient {
    private cfg: ResolvedConfig;
    private ws: WebSocket | null = null;
    private authenticated = false;
    private reqCounter = 1;
    private pending = new Map<string, PendingReq>();

    constructor(override: OpenclawConnConfig = {}) {
        this.cfg = loadOpenclawConfig(override);
    }

    get url(): string {
        return this.cfg.url;
    }

    /** 连接并完成认证 */
    connect(timeoutMs = 15000): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = (err?: Error) => {
                if (settled) return;
                settled = true;
                if (err) reject(err);
                else resolve();
            };

            const ws = new WebSocket(this.cfg.url);
            this.ws = ws;

            const connectTimer = setTimeout(() => {
                done(new Error(`连接/认证超时(${timeoutMs}ms)@ ${this.cfg.url}`));
                ws.close();
            }, timeoutMs);

            ws.on('open', () => {
                // 等待 connect.challenge 事件,不在此主动发起
            });

            ws.on('message', (data: WebSocket.RawData) => {
                let msg: any;
                try {
                    msg = JSON.parse(data.toString());
                } catch {
                    return;
                }
                this.handleMessage(msg, () => {
                    clearTimeout(connectTimer);
                    done();
                }, (e) => {
                    clearTimeout(connectTimer);
                    done(e);
                });
            });

            ws.on('error', (err: Error) => {
                clearTimeout(connectTimer);
                done(new Error(`WebSocket 错误:${err.message}`));
            });

            ws.on('close', () => {
                this.authenticated = false;
                // 清理所有挂起请求
                for (const [, p] of this.pending) {
                    clearTimeout(p.timer);
                    p.reject(new Error('连接已关闭'));
                }
                this.pending.clear();
            });
        });
    }

    private handleMessage(
        msg: any,
        onAuthOk: () => void,
        onAuthFail: (e: Error) => void
    ): void {
        // 1) 收到 challenge → 发送签名认证
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
            const nonce = msg.payload?.nonce;
            const signedAtMs = Date.now();
            const payload = buildSigningPayload({
                deviceId: this.cfg.identity.deviceId,
                role: ROLE,
                scopes: SCOPES,
                signedAtMs,
                token: this.cfg.token,
                nonce,
            });
            const signature = signPayload(this.cfg.identity.privateKeyPem, payload);
            this.send({
                type: 'req',
                id: 'auth-1',
                method: 'connect',
                params: {
                    minProtocol: 3,
                    maxProtocol: 3,
                    client: { id: 'cli', version: '1.0.0', platform: 'win32', mode: 'cli' },
                    role: ROLE,
                    scopes: SCOPES,
                    auth: { token: this.cfg.token },
                    device: {
                        id: this.cfg.identity.deviceId,
                        publicKey: base64UrlEncode(publicKeyRaw(this.cfg.identity.publicKeyPem)),
                        signature,
                        signedAt: signedAtMs,
                        nonce,
                    },
                },
            });
            return;
        }

        // 2) 认证响应
        if (msg.type === 'res' && msg.id === 'auth-1') {
            if (msg.ok) {
                this.authenticated = true;
                onAuthOk();
            } else {
                onAuthFail(new Error(`认证失败:${JSON.stringify(msg.error ?? msg)}`));
            }
            return;
        }

        // 3) 其它 res:匹配挂起请求(如 chat.send 的 runId)
        if (msg.type === 'res' && msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) {
                p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
            } else {
                p.resolve(msg.payload ?? msg.result ?? msg);
            }
            return;
        }

        // 4) 事件:派发给草稿监听器
        this.emitEvent(msg);
    }

    private eventListeners = new Set<(msg: any) => void>();
    private emitEvent(msg: any): void {
        for (const fn of this.eventListeners) {
            fn(msg);
        }
    }

    private send(obj: unknown): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj));
        }
    }

    /** 发送一个 req 并等待其 res */
    private sendAndWait(req: { id: string; [k: string]: unknown }, timeoutMs = 10000): Promise<any> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(req.id);
                reject(new Error('请求超时'));
            }, timeoutMs);
            this.pending.set(req.id, { resolve, reject, timer });
            this.send(req);
        });
    }

    /**
     * 请求 agent 生成草稿:chat.send(deliver:false),等待 chat final 事件取文本。
     */
    requestDraft(sessionKey: string, message: string, timeoutMs = 60000): Promise<string> {
        if (!this.authenticated) {
            return Promise.reject(new Error('尚未认证,无法请求草稿'));
        }
        const id = `draft-${this.reqCounter++}`;
        return new Promise<string>((resolve, reject) => {
            let resolved = false;
            let runId: string | null = null;

            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`agent 草稿请求超时(${timeoutMs}ms)`));
            }, timeoutMs);

            const cleanup = (): void => {
                resolved = true;
                clearTimeout(timer);
                this.eventListeners.delete(onEvent);
            };

            const onEvent = (msg: any): void => {
                if (resolved) return;
                if (msg.type !== 'event' || msg.event !== 'chat') return;
                const p = msg.payload ?? {};
                const matchByRun =
                    runId != null && (p.runId === runId || p.id === runId || p.run?.id === runId);
                const matchBySession = p.sessionKey === sessionKey;
                if (!matchByRun && !matchBySession) return;
                if (p.state && p.state !== 'final') return;
                const text = extractDraftText(p);
                if (text) {
                    cleanup();
                    resolve(text);
                }
            };
            this.eventListeners.add(onEvent);

            // 先发 chat.send 拿 runId,再等 chat final 事件
            this.sendAndWait(
                {
                    type: 'req',
                    id,
                    method: 'chat.send',
                    params: {
                        sessionKey,
                        message,
                        deliver: false,
                        idempotencyKey: randomUUID(),
                    },
                },
                Math.min(timeoutMs, 20000)
            )
                .then((payload) => {
                    runId = payload?.runId ?? payload?.id ?? payload?.run?.id ?? null;
                })
                .catch((err) => {
                    if (!resolved) {
                        cleanup();
                        reject(err);
                    }
                });
        });
    }

    close(): void {
        try {
            this.ws?.close();
        } catch {
            // 忽略
        }
    }
}

/** 从 chat 事件 payload 提取草稿文本(多重兜底) */
function extractDraftText(payload: any): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const content = payload.message?.content;
    if (Array.isArray(content)) {
        const parts = content
            .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
            .map((c: any) => c.text);
        if (parts.length > 0) {
            const joined = parts.join('').trim();
            if (joined) return joined;
        }
    }
    const candidates = [
        payload.text,
        typeof payload.message === 'string' ? payload.message : null,
        payload.content,
        payload.reply,
        payload.draft,
        payload.response,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
}
