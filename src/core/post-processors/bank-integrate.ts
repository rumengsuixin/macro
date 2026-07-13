// 后处理器:bank-integrate-domestic —— 把一批合规命名的国内银行流水文件,
// 交给外部 xlsxIntgration(Python)整合成「国内银行汇总.xlsx」,回收到 exports/。
// 桥接方式:临时输入/输出目录(隔离,不污染 xlsxIntgration 的 data/)+ 环境变量
//   BANK_INPUT_DIR/BANK_OUTPUT_DIR + spawn Python(见 python-bridge)。
// 命名约定:输入文件名须为 {公司}-{银行}.{xls|xlsx|csv}(PoC 假设已合规,自动映射留后续)。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { PostProcessSpec, PostProcessResult } from '../macro-types';
import { logInfo, logError } from '../logger';
import { registerPostProcessor, type PostProcessContext, type PostProcessHandler } from './index';
import { loadBankIntegrateConfig } from './bank-integrate-config';
import { runPython } from './python-bridge';

/** 可作为银行流水源的扩展名(小写含点) */
const SUPPORTED_EXT = ['.csv', '.xls', '.xlsx'];

const handler: PostProcessHandler = async (
    spec: PostProcessSpec,
    ctx: PostProcessContext
): Promise<PostProcessResult> => {
    if (!ctx.dataRoot) {
        return { type: spec.type, message: '缺少配置根目录(dataRoot),无法定位 bank-integrate.json。' };
    }
    const cfg = loadBankIntegrateConfig(path.join(ctx.dataRoot, 'bank-integrate.json'));
    const mode = cfg.modes[spec.type];
    if (!mode) {
        return { type: spec.type, message: `bank-integrate.json 未配置模式「${spec.type}」。` };
    }
    if (!fs.existsSync(cfg.pythonExe)) {
        return {
            type: spec.type,
            message: `未找到 Python 可执行:${cfg.pythonExe}(请在 bank-integrate.json 配置正确路径)。`,
        };
    }

    // 只取合规扩展名的银行文件,忽略其它下载(如错点了 zip/图片)
    const sources = ctx.downloads.filter((f) => SUPPORTED_EXT.includes(path.extname(f).toLowerCase()));
    if (sources.length === 0) {
        return { type: spec.type, message: '没有可整合的银行文件(csv/xls/xlsx)。' };
    }

    // 临时输入/输出目录:与 xlsxIntgration 自身 data/ 隔离,支持并发、无需清理仓库
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-bank-'));
    const inputDir = path.join(workRoot, 'input');
    const outputDir = path.join(workRoot, 'output');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    try {
        for (const f of sources) {
            fs.copyFileSync(f, path.join(inputDir, path.basename(f)));
        }
        logInfo(`银行整合:已准备 ${sources.length} 个输入文件,调用 Python(${mode.entryScript})……`);

        const res = await runPython({
            exe: cfg.pythonExe,
            args: [mode.entryScript],
            cwd: cfg.projectRoot,
            env: { BANK_INPUT_DIR: inputDir, BANK_OUTPUT_DIR: outputDir },
            timeoutMs: cfg.timeoutMs ?? 300000,
            onLog: (line) => logInfo(`[py] ${line}`),
        });

        if (res.timedOut) {
            throw new Error(`Python 整合超时(${cfg.timeoutMs ?? 300000}ms)。`);
        }
        if (res.exitCode !== 0) {
            // 取 stderr/stdout 末尾若干行作为失败摘要(完整输出已通过 onLog 打进日志)
            const tail =
                res.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-5).join(' / ') ||
                res.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / ') ||
                '(无输出)';
            throw new Error(`Python 整合失败(退出码 ${res.exitCode}):${tail}`);
        }

        const produced = path.join(outputDir, mode.summaryFile);
        if (!fs.existsSync(produced)) {
            throw new Error(`Python 已结束但未找到产物:${mode.summaryFile}`);
        }

        // 回收到 macro exports/,带时间戳避免覆盖
        const ext = path.extname(mode.summaryFile);
        const base = path.basename(mode.summaryFile, ext);
        const dest = path.join(ctx.exportsDir, `${base}-${ctx.stamp}${ext}`);
        fs.copyFileSync(produced, dest);
        logInfo(`银行整合完成 → ${dest}`);
        return {
            type: spec.type,
            output: dest,
            message: `已整合 ${sources.length} 个银行文件 → ${path.basename(dest)}`,
        };
    } finally {
        try {
            fs.rmSync(workRoot, { recursive: true, force: true });
        } catch (err) {
            logError(`清理临时目录失败(忽略):${err instanceof Error ? err.message : String(err)}`);
        }
    }
};

registerPostProcessor(
    {
        type: 'bank-integrate-domestic',
        label: '国内银行流水整合',
        description:
            '把一批合规命名的国内银行流水({公司}-{银行}.xls/xlsx/csv)交给 xlsxIntgration(Python)整合成汇总 xlsx',
    },
    handler
);
