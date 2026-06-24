// 稳定 selector 生成器:在浏览器页面(DOM)上下文中运行。
// 由 webview-preload 在录制时调用,为用户操作的元素生成尽量稳定、唯一的选择器。
//
// 本文件不依赖任何外部模块,保证可被 Electron preload 直接 require。
// 生成的 selector 兼容 Playwright:CSS 选择器直接使用,XPath 以 "xpath=" 前缀表示。
//
// 优先级:data-testid > id > name > aria-label > role+文本 > class > css path > xpath 兜底。

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
function isStableClass(cls: string): boolean {
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
    return true;
}

/** 构造 CSS path:从目标向上,遇到唯一 id 的祖先则截断 */
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

        let segment = node.tagName.toLowerCase();
        const parent: Element | null = node.parentElement;
        if (parent) {
            const tagName = node.tagName;
            const sameTag = Array.from(parent.children).filter((c) => c.tagName === tagName);
            if (sameTag.length > 1) {
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
