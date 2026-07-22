// 后处理器:bank-integrate-* —— 把一批合规命名的文件交给外部 xlsxIntgration(打包 exe)
// 整合/对账成 xlsx,回收到 exports/。覆盖 A 类"文件进→xlsx 出"对账/整合线:
//   代号1 国内银行 / 2 海外银行 / 3 游戏订单匹配 / 5 代付对账 / 6 代收代付对账。
// 桥接:临时输入/输出目录(隔离,不污染 xlsxIntgration 的 data/)+ 环境变量
//   BANK_INPUT_DIR/BANK_OUTPUT_DIR + spawn 平台可执行文件(见 subprocess-bridge)。
// 产物回收:各代号产物名不一(代号2 固定名、3/5/6 带日期戳),故不按固定名匹配,而是
//   取隔离输出目录里最新的 .xlsx(每次 spawn 新建目录、只有本次一个产物)。
// 输入筛选:按扩展名(csv/xls/xlsx/pdf——pdf 供代号2 华美银行);多类前缀文件保留原名交 Python 分类。
// 输入校验(admin 必需/EPIN 成对等)交给 Python 自己报错(退出码非0→throw),macro 不重复校验。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { PostProcessSpec, PostProcessResult } from '../macro-types';
import { logInfo, logError } from '../logger';
import { registerPostProcessor, type PostProcessContext, type PostProcessHandler } from './index';
import { loadBankIntegrateConfig } from './bank-integrate-config';
import { runSubprocess } from './subprocess-bridge';

/** 可作为输入源的扩展名(小写含点;pdf 供代号2 华美银行) */
const SUPPORTED_EXT = ['.csv', '.xls', '.xlsx', '.pdf'];

/** 取目录里最新(mtime 最大)的 .xlsx 绝对路径;无则返回 null。跳过 Excel 临时锁文件 ~$ */
function findProducedXlsx(dir: string): string | null {
    let best: { p: string; m: number } | null = null;
    for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('~$') || path.extname(name).toLowerCase() !== '.xlsx') {
            continue;
        }
        const p = path.join(dir, name);
        const m = fs.statSync(p).mtimeMs;
        if (!best || m > best.m) {
            best = { p, m };
        }
    }
    return best ? best.p : null;
}

const handler: PostProcessHandler = async (
    spec: PostProcessSpec,
    ctx: PostProcessContext
): Promise<PostProcessResult> => {
    if (!ctx.dataRoot) {
        return { type: spec.type, message: '缺少配置根目录(dataRoot),无法定位 bank-integrate.json。' };
    }
    const cfg = loadBankIntegrateConfig(
        path.join(ctx.dataRoot, 'bank-integrate.json'),
        ctx.bankTemplatePath
    );
    const mode = cfg.modes[spec.type];
    if (!mode) {
        return { type: spec.type, message: `bank-integrate.json 未配置模式「${spec.type}」。` };
    }
    const executable = mode.executable;
    if (!executable || !fs.existsSync(executable)) {
        return {
            type: spec.type,
            message: `未找到可执行文件:${executable || '(未配置)'}(请在 bank-integrate.json 配置,或先在 xlsxIntgration 侧打包)。`,
        };
    }

    // 只取合规扩展名的文件,忽略其它下载(如错点了 zip/图片);多类前缀文件保留原名交 Python 分类
    const sources = ctx.downloads.filter((f) => SUPPORTED_EXT.includes(path.extname(f).toLowerCase()));
    if (sources.length === 0) {
        return { type: spec.type, message: '没有可整合的文件(csv/xls/xlsx/pdf)。' };
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
        logInfo(`银行整合:已准备 ${sources.length} 个输入文件,调用可执行文件(${path.basename(executable)})……`);

        const res = await runSubprocess({
            exe: executable,
            args: [],
            cwd: path.dirname(executable),
            env: { BANK_INPUT_DIR: inputDir, BANK_OUTPUT_DIR: outputDir },
            timeoutMs: cfg.timeoutMs ?? 300000,
            onLog: (line) => logInfo(`[py] ${line}`),
        });

        if (res.timedOut) {
            throw new Error(`整合超时(${cfg.timeoutMs ?? 300000}ms)。`);
        }
        if (res.exitCode !== 0) {
            // 取 stderr/stdout 末尾若干行作为失败摘要(完整输出已通过 onLog 打进日志)
            const tail =
                res.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-5).join(' / ') ||
                res.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / ') ||
                '(无输出)';
            throw new Error(`整合失败(退出码 ${res.exitCode}):${tail}`);
        }

        // 产物回收:取隔离输出目录里最新的 xlsx(兼容固定名与带日期名,统一 5 个代号)
        const produced = findProducedXlsx(outputDir);
        if (!produced) {
            throw new Error('可执行文件已结束但输出目录里未找到产物 xlsx。');
        }

        // 回收到 macro exports/,保留产物原名 + 时间戳避免覆盖
        const ext = path.extname(produced);
        const base = path.basename(produced, ext);
        const dest = path.join(ctx.exportsDir, `${base}-${ctx.stamp}${ext}`);
        fs.copyFileSync(produced, dest);
        logInfo(`银行整合完成 → ${dest}`);
        return {
            type: spec.type,
            output: dest,
            message: `已整合 ${sources.length} 个文件 → ${path.basename(dest)}`,
        };
    } finally {
        try {
            fs.rmSync(workRoot, { recursive: true, force: true });
        } catch (err) {
            logError(`清理临时目录失败(忽略):${err instanceof Error ? err.message : String(err)}`);
        }
    }
};

/** 各代号的插件元数据(type 须与 bank-integrate-config 的 EXE_NAMES 键一致);handler 共享 */
const REGISTRATIONS: Array<{ type: string; label: string; description: string }> = [
    {
        type: 'bank-integrate-domestic',
        label: '国内银行流水整合',
        description: '把一批 {公司}-{银行}.xls/xlsx/csv 国内银行流水交给 xlsxIntgration 整合成汇总 xlsx',
    },
    {
        type: 'bank-integrate-overseas',
        label: '海外银行流水整合',
        description: '把 {公司}-{银行}-{币种} 海外银行流水(xls/xlsx/csv,华美银行支持 pdf)整合成汇总 xlsx',
    },
    {
        type: 'bank-integrate-order-match',
        label: '游戏订单匹配对账',
        description: '把 admin 订单 + Adyen/华为/Google/苹果 平台文件匹配对账,产出订单匹配结果 xlsx',
    },
    {
        type: 'bank-integrate-payout',
        label: '代付订单对账',
        description: '把 admin 主表 + IBF/SUPERPAY/Wangupay/话费卡/EPIN 平台文件对账,产出代付对账结果 xlsx',
    },
    {
        type: 'bank-integrate-collection-payout',
        label: '代收代付对账',
        description: '把 admin 收款/兑换主表 + betcat/Cashnewpay 平台文件对账,产出代收代付对账结果 xlsx',
    },
];

for (const r of REGISTRATIONS) {
    // standalone: true —— 银行整合/对账本质是「独立工具」(输入是人工归集的银行/对账文件,
    // 非宏回放产物),前端渲染到独立工具板块、不带随宏勾选框,只走「直接运行(选文件)」通道。
    registerPostProcessor(
        { type: r.type, label: r.label, description: r.description, standalone: true },
        handler
    );
}
