// AI 提取自检脚本:验证 macro 能否对接 openclaw agent 并产出提取规则。
// 验证整链:连 OpenClaw Gateway → Ed25519 认证 → chat.send(deliver:false) → 收回草稿 → 解析 JSON。
// 用法:
//   node scripts/test-ai.mjs                       # 用默认配置档(webextract)
//   node scripts/test-ai.mjs webextract            # 指定配置档 id
//   node scripts/test-ai.mjs webextract "采集标题和价格"
// 前提:OpenClaw Gateway 正在运行;需先 npm run build 生成 dist/core/ai-extract.js。
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

const profileId = process.argv[2] || undefined;
const requirement = process.argv[3] || '采集每本书的标题、价格、详情链接';

// 一段贴近 books.toscrape.com 结构的示例 HTML,便于 agent 产出 list 规则
const SAMPLE_HTML = `<!DOCTYPE html><html><head><title>示例书店</title>
<style>.x{color:red}</style><script>console.log('noise')</script></head>
<body><section><ol class="row">
<li><article class="product_pod">
  <h3><a href="catalogue/book-1.html" title="深入理解计算机系统">深入理解计算机系...</a></h3>
  <div class="product_price"><p class="price_color">£51.77</p>
  <p class="instock availability">In stock</p></div>
</article></li>
<li><article class="product_pod">
  <h3><a href="catalogue/book-2.html" title="算法导论">算法导论</a></h3>
  <div class="product_price"><p class="price_color">£20.66</p>
  <p class="instock availability">In stock</p></div>
</article></li>
</ol></section></body></html>`;

async function main() {
    console.log('=== AI 提取自检(对接 openclaw agent)===');
    try {
        const info = ai.listProfiles();
        console.log('配置文件:', ai.getConfigPath());
        console.log('默认配置档:', info.defaultProfile);
        console.log('可用配置档:');
        for (const p of info.profiles) {
            console.log(`  - ${p.id}  [agent=${p.agentId}]  ${p.label}`);
        }
    } catch (e) {
        console.error('读取配置失败:', e);
        process.exit(1);
    }

    console.log(`\n调用配置档:${profileId ?? '(默认)'}`);
    console.log(`采集需求:${requirement}`);
    console.log('连接 OpenClaw 并请求 agent,请稍候……\n');

    const res = await ai.generateExtract({ requirement, html: SAMPLE_HTML, profileId });

    console.log('=== 结果 ===');
    console.log(`成功:${res.ok} | 配置档:${res.profileLabel} | 耗时:${res.elapsedMs}ms`);
    if (res.ok) {
        console.log('生成的提取规则:');
        console.log(JSON.stringify(res.rules, null, 2));
    } else {
        console.log('错误:', res.error);
        if (res.raw) {
            console.log('\nagent 原始回复(用于排查):');
            console.log(res.raw.slice(0, 2000));
        }
        process.exit(2);
    }
}

main().catch((e) => {
    console.error('自检脚本异常:', e);
    process.exit(1);
});
