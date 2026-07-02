// 选择器校正自检脚本:验证 macro 能否对接 selector-fix openclaw agent 并产出稳定选择器。
// 验证整链:连 OpenClaw Gateway → Ed25519 认证 → chat.send(deliver:false) → 收回草稿 → 解析 {selector}。
// 用法:
//   node scripts/test-selector-fix.mjs                 # 用默认档(selector-fix)
//   node scripts/test-selector-fix.mjs selector-fix    # 指定配置档 id
// 前提:OpenClaw Gateway 正在运行;需先 npm run build 生成 dist/core/ai-extract.js;
//       且已创建 selector-fix agent(openclaw agents add selector-fix + 写 SOUL.md)。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(here, '..', 'dist', 'core', 'ai-extract.js');

if (!fs.existsSync(modPath)) {
    console.error('未找到 dist/core/ai-extract.js,请先运行 npm run build');
    process.exit(1);
}

const ai = require(modPath);

const profileId = process.argv[2] || 'selector-fix';

// 模拟一个「脆弱选择器 + 稳定锚点」的场景:目标是一个带 aria-label 的按钮,
// 但它被裹在含随机 id / FB Stylex 原子类的祖先里,原选择器用了这些垃圾特征。
const current =
    '#_r_3_ > div.xwoeoq.xggcdpo > div.xeuugli:nth-of-type(2) > div.xryxfnj > button.x1lliihq';
const elementHtml =
    '<button aria-label="创建新账户" data-testid="open-registration-form" ' +
    'class="x1lliihq x6ikm8r x10wlt62">创建新账户</button>';
const ancestors = [
    'div#_r_3_ class="xwoeoq xggcdpo"',
    'div [role="dialog" aria-label="登录"] class="xeuugli x78zum5"',
    'form#login_form class="xdqstbe"',
].join('\n');

// 已知垃圾 token:校正后的选择器不应再包含它们
const JUNK = ['_r_3_', '_R_', 'xwoeoq', 'xggcdpo', 'xeuugli', 'xryxfnj', 'x1lliihq', 'nth-of-type'];

async function main() {
    console.log('=== 选择器校正自检(对接 selector-fix agent)===');
    try {
        const info = ai.listProfiles();
        console.log('配置文件:', ai.getConfigPath());
        console.log('可用配置档:');
        for (const p of info.profiles) {
            console.log(`  - ${p.id}  [agent=${p.agentId}]  ${p.label}`);
        }
    } catch (e) {
        console.error('读取配置失败:', e);
        process.exit(1);
    }

    console.log(`\n调用配置档:${profileId}`);
    console.log('当前(脆弱)选择器:', current);
    console.log('连接 OpenClaw 并请求 agent,请稍候……\n');

    const res = await ai.fixSelector({
        profileId,
        current,
        reason: '含随机 id(_r_3_)与 FB Stylex 原子类',
        elementHtml,
        ancestors,
    });

    console.log('=== 结果 ===');
    console.log(`成功:${res.ok} | 配置档:${res.profileLabel} | 耗时:${res.elapsedMs}ms`);
    if (!res.ok || !res.selector) {
        console.log('错误:', res.error);
        if (res.raw) {
            console.log('\nagent 原始回复(用于排查):');
            console.log(res.raw.slice(0, 2000));
        }
        process.exit(2);
    }

    console.log('校正后的选择器:', res.selector);

    let failed = 0;
    if (!res.selector.trim()) {
        console.error('  [失败] 返回选择器为空');
        failed += 1;
    }
    const hitJunk = JUNK.filter((t) => res.selector.includes(t));
    if (hitJunk.length > 0) {
        console.error(`  [失败] 校正后仍含垃圾特征:${hitJunk.join(', ')}`);
        failed += 1;
    }

    if (failed > 0) {
        console.error(`\n自检未通过(${failed} 项),请检查 selector-fix agent 的 SOUL.md 选择器质量准则。`);
        process.exit(3);
    }
    console.log('\n自检通过:selector-fix 产出的选择器非空且不含已知垃圾特征(随机 id / 原子类 / nth-of-type)。');
    console.log('提示:它应锚定 data-testid / aria-label / #login_form 等稳定特征。');
}

main().catch((e) => {
    console.error('自检脚本异常:', e);
    process.exit(1);
});
