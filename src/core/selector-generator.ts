// 稳定 selector 生成器:在浏览器页面(DOM)上下文中运行。
// 由 webview-preload 在录制时调用,为用户操作的元素生成尽量稳定、唯一的选择器。
//
// 本文件不依赖任何外部模块,保证可被 Electron preload 直接 require。
// 生成的 selector 兼容 Playwright:CSS 选择器直接使用,XPath 以 "xpath=" 前缀表示。
//
// 优先级:data-testid > id > name > aria-label > role+文本 > class > css path > xpath 兜底。

import type { ElementFingerprint } from './macro-types';

/**
 * 为给定元素生成稳定的 selector。
 * 每个候选都会校验唯一性(CSS 用 querySelectorAll,XPath 用 document.evaluate),命中唯一即返回。
 */
export function generateSelector(el: Element): string {
    if (!el || el.nodeType !== 1) {
        return '';
    }

    // 1. data-testid / data-test / data-cy
    for (const attr of ['data-testid', 'data-test', 'data-cy']) {
        const val = el.getAttribute(attr);
        if (val) {
            const sel = `[${attr}="${escapeAttrValue(val)}"]`;
            if (isUniqueCss(sel, el)) {
                return sel;
            }
        }
    }

    // 2. id(不含空白即可作为候选)
    const id = el.getAttribute('id');
    if (id && !/\s/.test(id)) {
        const sel = `#${cssEscape(id)}`;
        if (isUniqueCss(sel, el)) {
            return sel;
        }
    }

    // 3. name(表单元素常用)
    const name = el.getAttribute('name');
    if (name) {
        const sel = `${el.tagName.toLowerCase()}[name="${escapeAttrValue(name)}"]`;
        if (isUniqueCss(sel, el)) {
            return sel;
        }
    }

    // 4. aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
        const sel = `[aria-label="${escapeAttrValue(ariaLabel)}"]`;
        if (isUniqueCss(sel, el)) {
            return sel;
        }
    }

    // 5. role + 文本(无子元素的短文本元素)→ XPath
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 50 && el.children.length === 0) {
        const tag = el.tagName.toLowerCase();
        const expr = `//${tag}[normalize-space(.)=${xpathLiteral(text)}]`;
        if (isUniqueXpath(expr, el)) {
            return `xpath=${expr}`;
        }
    }

    // 6. class 组合
    const classSel = buildClassSelector(el);
    if (classSel && isUniqueCss(classSel, el)) {
        return classSel;
    }

    // 7. CSS path(nth-of-type 父链)
    const cssPath = buildCssPath(el);
    if (cssPath && isUniqueCss(cssPath, el)) {
        return cssPath;
    }

    // 8. 绝对 XPath 兜底
    return `xpath=${buildAbsoluteXpath(el)}`;
}

/**
 * 为被点击元素生成语义指纹,随 click 步骤保存。回放时主选择器命中数 ≠1(页面结构漂移、
 * 录制后增减兄弟元素等)时,用这些与位置无关的语义信息通用重定位,不限分页器。
 */
export function buildFingerprint(el: Element): ElementFingerprint {
    const fp: ElementFingerprint = {};
    if (!el || el.nodeType !== 1) {
        return fp;
    }
    fp.tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) {
        fp.text = text.length > 80 ? text.slice(0, 80) : text;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) {
        fp.ariaLabel = aria;
    }
    const href = el.getAttribute('href');
    if (href) {
        fp.href = href;
    }
    const anchor = findStableAnchorSelector(el);
    if (anchor) {
        fp.anchor = anchor;
    }
    return fp;
}

/** 从元素向上(不含自身)找最近一个能被稳定锚点唯一标识的祖先,返回其选择器 */
function findStableAnchorSelector(el: Element): string | null {
    let node: Element | null = el.parentElement;
    let depth = 0;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html' && depth < 6) {
        // id
        if (node.id && !/\s/.test(node.id)) {
            const sel = `#${cssEscape(node.id)}`;
            if (isUniqueCss(sel, node)) {
                return sel;
            }
        }
        // data-*
        for (const attr of ['data-testid', 'data-test', 'data-cy']) {
            const val = node.getAttribute(attr);
            if (val) {
                const sel = `[${attr}="${escapeAttrValue(val)}"]`;
                if (isUniqueCss(sel, node)) {
                    return sel;
                }
            }
        }
        // aria-label
        const aria = node.getAttribute('aria-label');
        if (aria) {
            const sel = `[aria-label="${escapeAttrValue(aria)}"]`;
            if (isUniqueCss(sel, node)) {
                return sel;
            }
        }
        // 稳定 class 组合(如 li.next)
        const classSel = buildClassSelector(node);
        if (classSel && isUniqueCss(classSel, node)) {
            return classSel;
        }
        node = node.parentElement;
        depth += 1;
    }
    return null;
}

/** 校验 CSS 选择器是否唯一命中该元素 */
function isUniqueCss(selector: string, el: Element): boolean {
    try {
        const doc = el.ownerDocument;
        if (!doc) {
            return false;
        }
        const list = doc.querySelectorAll(selector);
        return list.length === 1 && list[0] === el;
    } catch {
        return false;
    }
}

/** 校验 XPath 表达式是否唯一命中该元素 */
function isUniqueXpath(expr: string, el: Element): boolean {
    try {
        const doc = el.ownerDocument;
        if (!doc) {
            return false;
        }
        const result = doc.evaluate(expr, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return result.snapshotLength === 1 && result.snapshotItem(0) === el;
    } catch {
        return false;
    }
}

/** 转义 CSS 标识符(id / class),优先使用浏览器原生 CSS.escape */
function cssEscape(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(value);
    }
    return value.replace(/([^\w-])/g, '\\$1');
}

/** 转义属性值(用于 [attr="value"]) */
function escapeAttrValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 生成 XPath 字符串字面量,正确处理引号 */
function xpathLiteral(value: string): string {
    if (value.indexOf('"') === -1) {
        return `"${value}"`;
    }
    if (value.indexOf("'") === -1) {
        return `'${value}'`;
    }
    // 同时包含单双引号时用 concat 拼接
    return `concat("${value.replace(/"/g, '", \'"\', "')}")`;
}

/** 用稳定的 class 组合构造选择器 */
function buildClassSelector(el: Element): string | null {
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList).filter(isStableClass);
    if (classes.length === 0) {
        return null;
    }
    return tag + classes.map((c) => `.${cssEscape(c)}`).join('');
}

/** 判断 class 是否「稳定」(过滤明显动态 / 哈希类名) */
export function isStableClass(cls: string): boolean {
    if (cls.length === 0) {
        return false;
    }
    if (/\d{4,}/.test(cls)) {
        return false; // 含较长数字串,疑似动态
    }
    if (cls.length >= 16 && /[0-9]/.test(cls) && /[a-z]/i.test(cls)) {
        return false; // 过长且数字字母混合,疑似哈希
    }
    if (/^(css|sc|jsx|emotion)-/.test(cls)) {
        return false; // 常见 CSS-in-JS 前缀
    }
    // Facebook Stylex 原子类:x 开头 + 纯小写字母数字且含数字的短哈希(每次发版都变)
    // 如 x1ey2m1c / x78zum5 / xdt5ytf / x1n2onr6 / xxo9b9y
    if (/^x[a-z0-9]{4,}$/.test(cls) && /[0-9]/.test(cls)) {
        return false;
    }
    // Twitter/X 原子类:r- 前缀 + 含数字的哈希,如 r-1xnzce8
    if (/^r-[a-z0-9]{5,}$/.test(cls) && /[0-9]/.test(cls)) {
        return false;
    }
    return true;
}

/**
 * 构造 CSS path:从目标向上,遇到唯一 id 的祖先则截断。
 * 每个 segment 在可用时携带稳定 class(如 li.next),`:nth-of-type` 仅在 class 仍无法
 * 区分同标签兄弟时才追加。这样选择器锚定语义稳定的 class 而非纯位置,避免「录制后页面
 * 增减兄弟元素(如分页器首页缺 Previous、翻页后出现)导致选择器命中数变化」的脆弱性。
 */
function buildCssPath(el: Element): string {
    const path: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
        // 若该节点带唯一 id,以 id 作为路径起点提前结束
        if (node.id && !/\s/.test(node.id)) {
            const idSel = `#${cssEscape(node.id)}`;
            if (isUniqueCss(idSel, node)) {
                path.unshift(idSel);
                return path.join(' > ');
            }
        }

        const tag = node.tagName.toLowerCase();
        // 该节点的稳定 class 组合(形如 li.next),无稳定 class 时为 null
        const classSel = buildClassSelector(node);
        // 稳定 class 提前截断:class 组合在文档内唯一命中该节点,且拼成的全路径仍唯一命中 el
        if (classSel && isUniqueCss(classSel, node)) {
            const candidate = [classSel, ...path].join(' > ');
            if (isUniqueCss(candidate, el)) {
                return candidate;
            }
        }

        let segment = tag;
        const parent: Element | null = node.parentElement;
        if (parent) {
            const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
            // classSel 去掉 tag 前缀即 ".classA.classB"(无稳定 class 时为空串)
            const classPart = classSel ? classSel.slice(tag.length) : '';
            if (classPart) {
                const sameTagSameClass = sameTag.filter((c) => c.matches(tag + classPart));
                // class 已能在同标签兄弟间唯一定位 → 用 tag.class(单独时也附上,守护未来出现的兄弟元素);
                // 否则 tag.class + nth-of-type 双保险
                segment +=
                    sameTagSameClass.length === 1
                        ? classPart
                        : `${classPart}:nth-of-type(${sameTag.indexOf(node) + 1})`;
            } else if (sameTag.length > 1) {
                segment += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
            }
        }
        path.unshift(segment);
        node = parent;
    }
    return path.join(' > ');
}

/** 构造绝对 XPath(兜底) */
function buildAbsoluteXpath(el: Element): string {
    const segments: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1) {
        let index = 1;
        let sibling = node.previousElementSibling;
        while (sibling) {
            if (sibling.tagName === node.tagName) {
                index += 1;
            }
            sibling = sibling.previousElementSibling;
        }
        segments.unshift(`${node.tagName.toLowerCase()}[${index}]`);
        node = node.parentElement;
    }
    return '/' + segments.join('/');
}
