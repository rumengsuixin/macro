// 通用下载捕获:在 context 层监听 download 事件,把回放过程中触发的所有下载落盘。
// 设计为「通用原语」——任何 mode 回放时触发的下载都会被保存,不只服务于 list-action。
// list-action 模式额外用 waitForNext 做逐项节流(点一项→等这次下载开始→再点下一项)。
import type { BrowserContext, Download } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { logInfo, logError } from './logger';

export class DownloadManager {
    /** 全部已成功保存的文件绝对路径 */
    readonly savedPaths: string[] = [];
    private saveDir: string;
    /** 等待「下一个下载」的解析队列(waitForNext 注册,download 落盘后按序唤醒) */
    private waiters: Array<(p: string) => void> = [];

    constructor(context: BrowserContext, saveDir: string) {
        this.saveDir = saveDir;
        context.on('download', (download) => {
            // 不 await:download 事件回调本身串行触发,内部各自完成保存即可
            void this.handleDownload(download);
        });
    }

    /** 已保存数量 */
    count(): number {
        return this.savedPaths.length;
    }

    /**
     * 等待「调用后的下一个新下载」完成保存,返回其保存路径;超时返回 null。
     * 用于 list-action 逐项节流;通用捕获本身不依赖它。
     */
    waitForNext(timeoutMs: number): Promise<string | null> {
        return new Promise<string | null>((resolve) => {
            let done = false;
            const finish = (p: string | null): void => {
                if (done) {
                    return;
                }
                done = true;
                resolve(p);
            };
            const timer = setTimeout(() => {
                // 超时:从队列里摘掉自己,避免后续下载误唤醒
                const idx = this.waiters.indexOf(waiter);
                if (idx >= 0) {
                    this.waiters.splice(idx, 1);
                }
                finish(null);
            }, timeoutMs);
            const waiter = (p: string): void => {
                clearTimeout(timer);
                finish(p);
            };
            this.waiters.push(waiter);
        });
    }

    /** 保存单个下载:用服务器建议名,重名加序号去重;失败不致命 */
    private async handleDownload(download: Download): Promise<void> {
        try {
            if (!fs.existsSync(this.saveDir)) {
                fs.mkdirSync(this.saveDir, { recursive: true });
            }
            const suggested = download.suggestedFilename() || 'download';
            const dest = this.dedupePath(suggested);
            await download.saveAs(dest);
            this.savedPaths.push(dest);
            logInfo(`已保存下载文件:${dest}`);
            // 唤醒一个等待者(FIFO),把保存路径交给它
            const waiter = this.waiters.shift();
            if (waiter) {
                waiter(dest);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`保存下载文件失败:${message}`);
        }
    }

    /** 目标文件已存在时,在扩展名前追加 (1)/(2)… 直到不冲突 */
    private dedupePath(filename: string): string {
        const ext = path.extname(filename);
        const stem = path.basename(filename, ext);
        let candidate = path.join(this.saveDir, filename);
        let n = 1;
        while (fs.existsSync(candidate)) {
            candidate = path.join(this.saveDir, `${stem} (${n})${ext}`);
            n += 1;
        }
        return candidate;
    }
}
