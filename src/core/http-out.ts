// 零依赖 HTTP 出站:用 node 内置 http/https 发一个请求(事件钩子 webhook 用)。
// 不引 axios/node-fetch。仅 http/https 协议;带超时;失败 reject 交调用方兜底(钩子层永不因此中断回放)。
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export interface HttpSendResult {
    status: number;
}

/**
 * 发送一个 HTTP(S) 请求。
 * @param rawUrl   目标 URL(仅 http/https,否则 reject)
 * @param method   方法,缺省 POST
 * @param headers  请求头(静态配置,调用方保证不含页面注入)
 * @param body     请求体字符串(可空)
 * @param timeoutMs 超时毫秒,缺省 10000,到点 destroy 连接
 */
export function httpSend(
    rawUrl: string,
    method: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number
): Promise<HttpSendResult> {
    return new Promise((resolve, reject) => {
        let u: URL;
        try {
            u = new URL(rawUrl);
        } catch {
            reject(new Error(`非法 webhook URL:${rawUrl}`));
            return;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            reject(new Error(`webhook 仅支持 http/https:${u.protocol}`));
            return;
        }
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(
            u,
            { method: method || 'POST', headers },
            (res) => {
                res.on('data', () => {
                    /* 读完丢弃,只关心状态码 */
                });
                res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
            }
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs > 0 ? timeoutMs : 10000, () => {
            req.destroy(new Error('webhook 请求超时'));
        });
        if (body) {
            req.write(body);
        }
        req.end();
    });
}
