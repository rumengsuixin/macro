// 后处理器:export-rows-excel
// 需求 —— 每个宏的采集数据都该有自己的文件名。手点「导出 Excel」只会给出固定的
// result-<时间戳>.xlsx,跑多条业务线时每次都要手打名字区分。
// 本插件随宏勾选,回放结束后把提取到的数据行按宏自配的文件名模板自动写进 exports/,
// 免去手点与改名;不改动、也不替代原有的「导出 Excel」按钮(两者并存)。
// 写:复用现有 exportToExcel(exceljs + ColumnSpec),不重写写盘逻辑。
import path from 'path';
import type { PostProcessSpec, PostProcessResult } from '../macro-types';
import { exportToExcel } from '../excel-exporter';
import { renderFileNameTemplate } from '../template-util';
import { logInfo } from '../logger';
import { registerPostProcessor, type PostProcessContext, type PostProcessHandler } from './index';

/** 未配文件名(或模板消毒后为空)时的缺省名,与手点导出按钮的默认名同口径 */
function fallbackName(stamp: string): string {
    return `result-${stamp}.xlsx`;
}

const handler: PostProcessHandler = async (
    spec: PostProcessSpec,
    ctx: PostProcessContext
): Promise<PostProcessResult> => {
    const rows = ctx.rows ?? [];
    if (rows.length === 0) {
        // 不是失败:list-action 这类模式本就只产下载文件;勾错了也不该报红中断后续后处理器
        logInfo('export-rows-excel:本次回放没有数据行,跳过导出。');
        return { type: spec.type, message: '本次回放没有数据行,已跳过。' };
    }

    const template = spec.options?.fileName;
    const fileName = renderFileNameTemplate(
        typeof template === 'string' ? template : undefined,
        {
            stamp: ctx.stamp,
            macro: ctx.macroName,
            plugin: spec.type,
            rows: rows.length,
        },
        fallbackName(ctx.stamp)
    );
    const output = path.join(ctx.exportsDir, fileName);
    await exportToExcel(rows, output, ctx.columns);
    return {
        type: spec.type,
        output,
        message: `已导出 ${rows.length} 行数据 → ${fileName}`,
    };
};

registerPostProcessor(
    {
        type: 'export-rows-excel',
        label: '采集数据导出 Excel(可配文件名)',
        // 输入是回放提取的数据行,不是人工选的文件 → 不提供「直接运行」(那条通道不跑宏、拿不到 rows)
        directRun: false,
        description:
            '回放结束后,把采集到的数据行按你指定的文件名自动存成 exports/ 下的 Excel,' +
            '不用再手点「导出 Excel」并改名。列名/列序/隐藏列/数字日期格式沿用提取规则里的字段设置。' +
            '没有数据行(如只下载文件的宏)则自动跳过。',
        optionFields: [
            {
                key: 'fileName',
                label: '文件名',
                placeholder: '数据-{macro}-{date}.xlsx',
                hint:
                    '可用占位符:{macro} 宏名 · {date} 日期(2026-08-12) · {time} 时分秒(143005) · ' +
                    '{stamp} 完整时间戳 · {rows} 行数。留空则用 result-<时间戳>.xlsx;' +
                    '不写 .xlsx 会自动补上;同名会覆盖,建议带 {date} 或 {stamp}。',
            },
        ],
    },
    handler
);
