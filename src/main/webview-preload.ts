// webview 录制 preload:注入到内置浏览器(<webview>)的页面中,
// 监听用户操作并生成宏步骤,通过 sendToHost 回传给宿主渲染进程。
//
// 运行在 guest 页面的隔离世界(主进程已为 webview 关闭 sandbox,故可 require 本地模块)。
// 不向页面主世界暴露任何对象,仅监听 DOM 事件。
import { ipcRenderer } from 'electron';
import { generateSelector, buildFingerprint } from '../core/selector-generator';
import type { Step } from '../core/macro-types';

let recording = false;

// 当前待提交的输入(在失焦 / 回车时生成 fill 步骤)
let pendingFill: { selector: string; value: string } | null = null;

// 接收宿主的录制开关(每次页面导航后宿主会重新发送以「重新武装」)
ipcRenderer.on('toggle-recording', (_event, on: boolean) => {
    recording = on;
    if (!on) {
        flushPendingFill();
    }
});

function sendStep(step: Step): void {
    ipcRenderer.sendToHost('macro-step', step);
}

function flushPendingFill(): void {
    if (pendingFill) {
        sendStep({ type: 'fill', selector: pendingFill.selector, value: pendingFill.value });
        pendingFill = null;
    }
}

/** 向上寻找更有意义的可点击祖先(按钮 / 链接),避免选中图标 span 等叶子节点 */
function resolveClickable(el: Element): Element {
    let node: Element | null = el;
    let depth = 0;
    while (node && depth < 4) {
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
            // 附语义指纹:回放时主选择器命中 ≠1 可据此通用重定位
            sendStep({ type: 'click', selector, fingerprint: buildFingerprint(el) });
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
                pendingFill = { selector, value: target.value };
            }
        } else if (target.isContentEditable) {
            const selector = generateSelector(target);
            if (selector) {
                pendingFill = { selector, value: target.innerText };
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
