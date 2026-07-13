// bank-integrate 插件的桥接配置:按平台指向 xlsxIntgration 的打包可执行文件(不再依赖 Python 脚本+venv)。
// 仿 storage/request-rules-store:不存在写模板 + 坏 JSON 兜底。放 core 内(只用 node:fs/path,不依赖 Electron)。
import fs from 'node:fs';
import path from 'node:path';

/** 单条业务线(mode):当前平台可执行文件路径 */
export interface BankIntegrateMode {
    /** 当前平台可执行文件绝对路径(Windows exe / Mac 二进制) */
    executable: string;
}

/** bank-integrate 桥接配置 */
export interface BankIntegrateConfig {
    /** 单次整合超时(毫秒),缺省 300000 */
    timeoutMs?: number;
    /** 插件 type → 业务线可执行文件入口 */
    modes: Record<string, BankIntegrateMode>;
}

/** 本机 xlsxIntgration 项目根默认值(用户可在配置里改路径) */
const DEFAULT_XLSX_ROOT = 'D:\\git_object\\xlsxIntgration';

/**
 * 各 mode(插件 type)在 win32/darwin 下的可执行文件名(不含目录)。
 * 覆盖 5 个代号:1 国内 / 2 海外 / 3 订单匹配 / 5 代付对账 / 6 代收代付对账。
 * - win32 名取自 bank_integration.spec(中文名)
 * - darwin 名取自 bank_integration_mac.spec(英文名,需在 Mac 上打包后才有实体)
 */
const EXE_NAMES: Record<string, { win32: string; darwin: string }> = {
    'bank-integrate-domestic': { win32: '国内银行整合.exe', darwin: 'domestic_bank_integration' },
    'bank-integrate-overseas': { win32: '海外银行整合.exe', darwin: 'overseas_bank_integration' },
    'bank-integrate-order-match': { win32: '游戏订单匹配.exe', darwin: 'order_payment_match' },
    'bank-integrate-payout': { win32: '代付订单对账.exe', darwin: 'payout_order_reconcile' },
    'bank-integrate-collection-payout': {
        win32: '代收代付对账.exe',
        darwin: 'collection_payout_reconcile',
    },
};

/**
 * 按平台给出某 mode 的默认可执行文件路径(仅支持 win32/darwin,未知 type 或其它平台留空)。
 * - win32:PyInstaller onedir 产物 dist/银行流水整合/<中文名>.exe
 * - darwin:需在 Mac 上跑 build_mac.sh 打出 dist/bank-integration/<英文名>
 */
function defaultExecutable(type: string, xlsxRoot: string): string {
    const names = EXE_NAMES[type];
    if (!names) {
        return '';
    }
    if (process.platform === 'win32') {
        return path.join(xlsxRoot, 'dist', '银行流水整合', names.win32);
    }
    if (process.platform === 'darwin') {
        return path.join(xlsxRoot, 'dist', 'bank-integration', names.darwin);
    }
    return '';
}

/** 默认/模板配置:按当前平台为 5 个代号各生成默认可执行文件路径 */
function templateConfig(): BankIntegrateConfig {
    const modes: Record<string, BankIntegrateMode> = {};
    for (const type of Object.keys(EXE_NAMES)) {
        modes[type] = { executable: defaultExecutable(type, DEFAULT_XLSX_ROOT) };
    }
    return { timeoutMs: 300000, modes };
}

/**
 * 加载 bank-integrate 配置。
 * - 不存在:写模板并返回(便于用户改路径)。
 * - 坏 JSON:回退模板默认。
 * - 某 mode 缺 executable:回退当前平台默认(兼容旧格式配置、不阻塞)。
 * @param filePath 配置文件路径(dataRoot/bank-integrate.json)
 */
export function loadBankIntegrateConfig(filePath: string): BankIntegrateConfig {
    const tpl = templateConfig();
    try {
        if (!fs.existsSync(filePath)) {
            try {
                fs.writeFileSync(filePath, JSON.stringify(tpl, null, 4), 'utf-8');
            } catch {
                /* 写模板失败(如只读目录)不致命 */
            }
            return tpl;
        }
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<BankIntegrateConfig>;
        const rawModes =
            raw.modes && typeof raw.modes === 'object' && !Array.isArray(raw.modes) ? raw.modes : {};
        // 以模板 modes 为底(保证 5 个代号默认都在),再并入用户配置;逐字段校验/回退
        const modes: Record<string, BankIntegrateMode> = { ...tpl.modes };
        for (const [type, m] of Object.entries(rawModes)) {
            const mm = (m && typeof m === 'object' ? m : {}) as Partial<BankIntegrateMode>;
            modes[type] = {
                executable:
                    typeof mm.executable === 'string' && mm.executable.trim()
                        ? mm.executable
                        : defaultExecutable(type, DEFAULT_XLSX_ROOT),
            };
        }
        return {
            timeoutMs:
                typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? raw.timeoutMs : tpl.timeoutMs,
            modes,
        };
    } catch {
        // 坏 JSON 等异常:回退模板默认
        return tpl;
    }
}
