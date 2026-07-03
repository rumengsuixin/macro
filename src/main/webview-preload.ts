// webview 录制 preload:注入到内置浏览器(<webview>)的页面中,
// 监听用户操作并生成宏步骤,通过 sendToHost 回传给宿主渲染进程。
//
// 运行在 guest 页面的隔离世界(主进程已为 webview 关闭 sandbox,故可 require 本地模块)。
// 不向页面主世界暴露任何对象,仅监听 DOM 事件。
import { ipcRenderer } from 'electron';
import { generateSelector, buildFingerprint, buildElementContext } from '../core/selector-generator';
import type { Step } from '../core/macro-types';

let recording = false;

// 当前待提交的输入(在失焦 / 回车时生成 fill 步骤)。
// 保留元素引用,提交时一并生成语义指纹(供「AI 校正选择器」在旧选择器失效时重定位)。
let pendingFill: { selector: string; value: string; el: Element } | null = null;

// 接收宿主的录制开关(每次页面导航后宿主会重新发送以「重新武装」)
ipcRenderer.on('toggle-recording', (_event, on: boolean) => {
    recording = on;
    if (!on) {
        flushPendingFill();
    }
});

// ===== 元素拾取器(picker)=====
// 进入拾取模式后:鼠标 hover 元素高亮、点击元素生成选择器回传宿主(用于「等待元素出现」步骤),
// 点击被拦截(不触发网页跳转、也不录制成 click 步骤),ESC 取消。
let picking = false;
let pickerStyleEl: HTMLStyleElement | null = null;
let hoveredEl: Element | null = null;
const PICKER_CLS = '__macro_picker_hover__';

// 接收宿主的拾取开关
ipcRenderer.on('toggle-picker', (_event, on: boolean) => {
    if (on) {
        enterPicker();
    } else {
        exitPicker(false);
    }
});

function enterPicker(): void {
    if (picking) {
        return;
    }
    picking = true;
    // 注入高亮样式:hover 元素加蓝色描边 + 半透明底,整页十字光标
    pickerStyleEl = document.createElement('style');
    pickerStyleEl.textContent =
        '.' + PICKER_CLS + '{outline:2px solid #2f6df6 !important;outline-offset:-2px !important;' +
        'background:rgba(47,109,246,.12) !important;}' +
        'html.' + PICKER_CLS + '-cur,html.' + PICKER_CLS + '-cur *{cursor:crosshair !important;}';
    document.documentElement.appendChild(pickerStyleEl);
    document.documentElement.classList.add(PICKER_CLS + '-cur');
    document.addEventListener('mouseover', onPickerOver, true);
    document.addEventListener('mouseout', onPickerOut, true);
    document.addEventListener('click', onPickerClick, true);
    document.addEventListener('keydown', onPickerKey, true);
}

function exitPicker(emitCancel: boolean): void {
    if (!picking) {
        return;
    }
    picking = false;
    clearHover();
    document.removeEventListener('mouseover', onPickerOver, true);
    document.removeEventListener('mouseout', onPickerOut, true);
    document.removeEventListener('click', onPickerClick, true);
    document.removeEventListener('keydown', onPickerKey, true);
    document.documentElement.classList.remove(PICKER_CLS + '-cur');
    if (pickerStyleEl) {
        pickerStyleEl.remove();
        pickerStyleEl = null;
    }
    if (emitCancel) {
        ipcRenderer.sendToHost('picker-result', { cancelled: true });
    }
}

function clearHover(): void {
    if (hoveredEl) {
        hoveredEl.classList.remove(PICKER_CLS);
        hoveredEl = null;
    }
}

function onPickerOver(event: Event): void {
    const t = event.target as Element | null;
    if (!t || t.nodeType !== 1) {
        return;
    }
    clearHover();
    hoveredEl = t;
    t.classList.add(PICKER_CLS);
}

function onPickerOut(): void {
    clearHover();
}

function onPickerClick(event: MouseEvent): void {
    // 拦截点击:不触发网页跳转,也不冒泡给网页自身监听
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const t = event.target as Element | null;
    if (!t || t.nodeType !== 1) {
        exitPicker(true);
        return;
    }
    // 关键:先摘掉拾取高亮类,再生成选择器,否则临时类 __macro_picker_hover__ 会被算进选择器
    clearHover();
    t.classList.remove(PICKER_CLS); // 双保险:确保被点元素自身无此类
    // 用户点的就是要等待的元素,直接生成选择器(不向上找可点击祖先)
    const selector = generateSelector(t);
    const fingerprint = buildFingerprint(t);
    const context = buildElementContext(t); // DOM 上下文:供该步离线 AI 校正
    exitPicker(false); // 先清理高亮/监听,再回传
    ipcRenderer.sendToHost('picker-result', { selector, fingerprint, context });
}

function onPickerKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        exitPicker(true);
    }
}

// 第 2 参 context 走独立 IPC 参数(不塞进 step),renderer 侧单独取用、不污染 step/宏 JSON
function sendStep(step: Step, context?: unknown): void {
    ipcRenderer.sendToHost('macro-step', step, context);
}

function flushPendingFill(): void {
    if (pendingFill) {
        sendStep(
            {
                type: 'fill',
                selector: pendingFill.selector,
                value: pendingFill.value,
                fingerprint: buildFingerprint(pendingFill.el),
            },
            buildElementContext(pendingFill.el)
        );
        pendingFill = null;
    }
}

/** 向上寻找更有意义的可点击祖先(按钮 / 链接),避免选中图标 span 等叶子节点。
 * 深度 8:FB 等站点的 div[role=button] 常在叶子之上 5~7 层,4 层不够。 */
function resolveClickable(el: Element): Element {
    let node: Element | null = el;
    let depth = 0;
    while (node && depth < 8) {
        if (node.tagName === 'A' || node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') {
            return node;
        }
        node = node.parentElement;
        depth += 1;
    }
    return el;
}

// 点击(capture 阶段,确保在可能的导航之前同步发出)
document.addEventListener(
    'click',
    (event) => {
        if (picking) {
            // 拾取模式下,点击交给 picker 处理,不录制成 click 步骤
            return;
        }
        if (!recording) {
            return;
        }
        const target = event.target as Element | null;
        if (!target || target.nodeType !== 1) {
            return;
        }
        flushPendingFill();
        const el = resolveClickable(target);
        const selector = generateSelector(el);
        if (selector) {
            // 附语义指纹(回放重定位)+ DOM 上下文(离线 AI 校正选择器)
            sendStep({ type: 'click', selector, fingerprint: buildFingerprint(el) }, buildElementContext(el));
        }
    },
    true
);

// 输入:暂存到 pendingFill(失焦 / 回车时提交)
document.addEventListener(
    'input',
    (event) => {
        if (!recording) {
            return;
        }
        const target = event.target as HTMLElement | null;
        if (!target) {
            return;
        }
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            const selector = generateSelector(target);
            if (selector) {
                pendingFill = { selector, value: target.value, el: target };
            }
        } else if (target.isContentEditable) {
            const selector = generateSelector(target);
            if (selector) {
                pendingFill = { selector, value: target.innerText, el: target };
            }
        }
    },
    true
);

// 失焦时提交输入
document.addEventListener(
    'focusout',
    () => {
        if (recording) {
            flushPendingFill();
        }
    },
    true
);

// 特殊按键:先提交输入,再记录 press
const specialKeys = new Set([
    'Enter',
    'Tab',
    'Escape',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
]);
document.addEventListener(
    'keydown',
    (event) => {
        if (!recording) {
            return;
        }
        if (!specialKeys.has(event.key)) {
            return;
        }
        const target = event.target as Element | null;
        let selector: string | undefined;
        if (target && target.nodeType === 1) {
            selector = generateSelector(target) || undefined;
        }
        flushPendingFill();
        sendStep({ type: 'press', selector, key: event.key });
    },
    true
);

// 滚动(防抖):记录窗口滚动位置。
// 运行在浏览器页面中,显式使用 window.setTimeout(返回 number),避免与 Node 类型歧义。
let scrollTimer: number | null = null;
document.addEventListener(
    'scroll',
    () => {
        if (!recording) {
            return;
        }
        if (scrollTimer !== null) {
            window.clearTimeout(scrollTimer);
        }
        scrollTimer = window.setTimeout(() => {
            sendStep({ type: 'scroll', x: window.scrollX, y: window.scrollY });
        }, 300);
    },
    true
);
