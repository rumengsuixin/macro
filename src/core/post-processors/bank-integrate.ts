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
import type { PostProcessSpec, PostProcessResult, PostProcessorManifest } from '../macro-types';
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
    // configDir 优先(主进程传 dataRoot/config),缺省回退 dataRoot(兼容只设 dataRoot 的旧自检 ctx)
    const cfgDir = ctx.configDir ?? ctx.dataRoot;
    if (!cfgDir) {
        return { type: spec.type, message: '缺少配置根目录,无法定位 bank-integrate.json。' };
    }
    const cfg = loadBankIntegrateConfig(
        path.join(cfgDir, 'bank-integrate.json'),
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
const REGISTRATIONS: Array<{
    type: string;
    label: string;
    description: string;
    /** 示例文件名(每个必需文件/平台前缀各一个,渲染成可点复制的 chip);仅示范,数字/后缀可改 */
    examples: string[];
}> = [
    {
        type: 'bank-integrate-domestic',
        label: '国内银行流水整合',
        description:
            '格式:.xls / .xlsx / .csv\n' +
            '命名:公司-银行全称.xlsx\n' +
            '可用银行(须写全称):招商银行 / 建设银行 / 工商银行 / 中信银行 / 浦发银行 / 农业银行 / 中国银行\n' +
            '提示:银行名须写全称(「招行」不识别)、区分大小写;公司名不能为空。',
        examples: ['瑞泽商务-中信银行.xlsx', '甲公司-招商银行.xls'],
    },
    {
        type: 'bank-integrate-overseas',
        label: '海外银行流水整合',
        description:
            '格式:.xls / .xlsx / .csv;华美银行仅接受 .pdf(文本型 PDF)\n' +
            '命名:公司-银行全称-币种.xlsx\n' +
            '币种:2~4 位大写字母(USD / HKD / SGD)\n' +
            '可用银行(全称):汇丰银行 / 东亚银行 / 华侨银行 / 渣打银行空中云汇 / 华美银行 / 大华银行（UOB) / 联昌国际银行（CIMB） / 招商银行 / 工商银行\n' +
            '提示:银行名区分大小写、括号须原样(全/半角);华美银行只走 PDF。',
        examples: ['A-东亚银行-HKD.csv', 'B-大华银行（UOB)-SGD.xlsx', '甲公司-华美银行-USD.pdf'],
    },
    {
        type: 'bank-integrate-order-match',
        label: '游戏订单匹配对账',
        description:
            '格式:.xls / .xlsx / .csv\n' +
            '必需:admin 订单主表(文件名以 admin 开头)\n' +
            '平台文件(文件名前缀,不分大小写):adyen- / 华为(月结算用「华为平台结算」)/ googol- 或 google- / 苹果\n' +
            '提示:admin 缺失会中止;其它平台缺失则跳过。',
        examples: [
            'admin订单.xlsx',
            'adyen-2026.xlsx',
            '华为平台结算2026.xlsx',
            'google-2026.csv',
            '苹果2026.xlsx',
        ],
    },
    {
        type: 'bank-integrate-payout',
        label: '代付订单对账',
        description:
            '格式:仅 .xls / .xlsx(不接受 .csv / .pdf)\n' +
            '必需:admin 主表(文件名以 admin- 开头)\n' +
            '平台文件(文件名前缀,不分大小写):ibfpay- 或 ibf平台 / superpay- / wangupay- 或 wangguypay- / okey话费卡结算 / EPIN 三件套 epin_siparisler_ + epin_pinler_ + epin_odemeler_ / Binance:usdt奖品发放信息 或 binance- 或 merged-\n' +
            '提示:只认 xls/xlsx;EPIN 需三个文件配套;admin 缺失会中止。',
        examples: [
            'admin-Okey兑换202604.xls',
            'superpay-2026.xls',
            'ibfpay-2026.xls',
            'wangupay-2026.xls',
            'okey话费卡结算2026.xls',
            'epin_siparisler_2026.xls',
            'epin_pinler_2026.xls',
            'epin_odemeler_2026.xls',
            'binance-2026.xls',
        ],
    },
    {
        type: 'bank-integrate-collection-payout',
        label: '代收代付对账',
        description:
            '格式:.xls / .xlsx / .csv\n' +
            '必需:两张 admin 主表——admin收款 + admin兑换(按前缀分收/付方向)\n' +
            '平台文件(文件名前缀,收款/代付分开):betcat-payment / betcat-payout、cashnewpay收款 / cashnewpay兑换、goldenpay收款 / goldenpay兑换\n' +
            '提示:收款用「…收款」或「-payment」,代付用「…兑换」或「-payout」;两张 admin 都缺会中止。',
        examples: [
            'admin收款202604.xlsx',
            'admin兑换202604.xlsx',
            'betcat-payment2026.csv',
            'betcat-payout2026.csv',
            'cashnewpay收款2026.xlsx',
            'cashnewpay兑换2026.xlsx',
            'goldenpay收款2026.xlsx',
            'goldenpay兑换2026.xlsx',
        ],
    },
];

for (const r of REGISTRATIONS) {
    // standalone: true —— 银行整合/对账本质是「独立工具」(输入是人工归集的银行/对账文件,
    // 非宏回放产物),前端渲染到独立工具板块、不带随宏勾选框,只走「直接运行(选文件)」通道。
    registerPostProcessor(
        {
            type: r.type,
            label: r.label,
            description: r.description,
            standalone: true,
            examples: r.examples,
        },
        handler
    );
}

/**
 * 用 bank-integrate.json 里各 mode 的可选 `description`/`examples` 覆盖对应工具的内置文案。
 * 只影响 cfg.modes 里出现的类型(即 bank-integrate-*),其它插件(如 merge)原样透传;
 * 某工具未配置 description/examples 时保留代码内置默认(缺省=现状)。
 * 由主进程 list-plugins 在返回 manifest 前调用(此时才知道 configDir)。
 * @param configPath   bank-integrate.json 绝对路径(dataRoot/config/bank-integrate.json)
 * @param templatePath 平台专属模板绝对路径(首次生成用),透传给 loadBankIntegrateConfig
 */
export function applyBankConfigToManifests(
    manifests: PostProcessorManifest[],
    configPath: string,
    templatePath?: string
): PostProcessorManifest[] {
    let cfg;
    try {
        cfg = loadBankIntegrateConfig(configPath, templatePath);
    } catch {
        return manifests; // 配置读失败不阻塞插件列表,回退内置文案
    }
    return manifests.map((m) => {
        const mode = cfg.modes[m.type];
        if (!mode) {
            return m;
        }
        return {
            ...m,
            description: mode.description ?? m.description,
            examples: mode.examples ?? m.examples,
        };
    });
}
