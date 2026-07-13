// 后处理器注册表:回放产出(数据/下载)后,按 Macro.postProcess 顺序执行的轻量扩展点。
// 设计取向:不搭通用插件框架,只用一个「type → {元数据, handler}」Map;新增定制后处理需求时
// 增加一个 handler 并自注册即可,UI 的可选插件列表由本注册表驱动(热插拔,前端零改动)。
// core 层不依赖 Electron。
import type { PostProcessSpec, PostProcessResult, PostProcessorManifest } from '../macro-types';
import { logInfo, logError } from '../logger';

/** 后处理器执行上下文(由主进程组装传入) */
export interface PostProcessContext {
    /** 本次回放新落盘的下载文件绝对路径(只处理这批,不扫 downloads/ 历史旧文件) */
    downloads: string[];
    /** 下载保存目录 */
    downloadDir: string;
    /** Excel 等产物输出目录 */
    exportsDir: string;
    /** 输出文件命名用时间戳(由主进程传入,core 层不调时间 API) */
    stamp: string;
    /** macro userData 根目录(由主进程传入),供需要读自身配置的后处理器定位,如 bank-integrate.json */
    dataRoot?: string;
}

/** 后处理器处理函数签名 */
export type PostProcessHandler = (
    spec: PostProcessSpec,
    ctx: PostProcessContext
) => Promise<PostProcessResult>;

const registry = new Map<string, { manifest: PostProcessorManifest; handler: PostProcessHandler }>();

/** 注册一个后处理器,带元数据(同 type 重复注册以最后一次为准) */
export function registerPostProcessor(manifest: PostProcessorManifest, handler: PostProcessHandler): void {
    registry.set(manifest.type, { manifest, handler });
}

/** 列出全部已注册插件的元数据(供 UI 渲染可选插件列表;注册顺序即展示顺序) */
export function listPostProcessors(): PostProcessorManifest[] {
    return [...registry.values()].map((e) => e.manifest);
}

/**
 * 按 specs 顺序执行全部后处理器,单个失败不致命(记入返回 message),不中断其余。
 * @returns 各后处理器的执行结果数组
 */
export async function runPostProcessors(
    specs: PostProcessSpec[],
    ctx: PostProcessContext
): Promise<PostProcessResult[]> {
    const results: PostProcessResult[] = [];
    for (const spec of specs) {
        const entry = registry.get(spec.type);
        if (!entry) {
            logError(`未知后处理器类型:${spec.type},跳过。`);
            results.push({ type: spec.type, message: `未知后处理器类型「${spec.type}」,已跳过。` });
            continue;
        }
        try {
            logInfo(`执行后处理器:${spec.type}……`);
            const r = await entry.handler(spec, ctx);
            logInfo(`后处理器 ${spec.type} 完成:${r.message}`);
            results.push(r);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`后处理器 ${spec.type} 执行失败:${message}`);
            results.push({ type: spec.type, message: `执行失败:${message}` });
        }
    }
    return results;
}

// 自注册内置后处理器(import 即触发其 registerPostProcessor 调用)
import './merge-zip-excel';
import './bank-integrate';
