// 渲染进程逻辑:UI 交互、收集录制步骤、调用 electronAPI。
// 本文件自包含:仅依赖 DOM 与 window.electronAPI,不导入任何 Node / core 模块,
// 因此 Playwright 等对象不会进入渲染进程。

// ===== 本地类型声明(与主进程 DSL 结构对应,但保持解耦) =====
interface Step {
    type: string;
    [key: string]: unknown;
}

interface Macro {
    name: string;
    version: number;
    steps: Step[];
    extract?: unknown;
    postProcess?: Array<{ type: string; options?: Record<string, unknown> }>;
}

interface LogMessage {
    level: 'info' | 'error';
    message: string;
    time: string;
}

interface RunError {
    stepIndex: number;
    stepType: string;
    selector?: string;
    url?: string;
    message: string;
    screenshot?: string;
}

interface PostProcessResult {
    type: string;
    output?: string;
    message: string;
}

interface PostProcessorManifest {
    type: string;
    label: string;
    description: string;
}

interface RunResult {
    ok: boolean;
    rows?: Record<string, string>[];
    downloads?: string[];
    postProcessed?: PostProcessResult[];
    error?: RunError;
}

interface AiProfileSummary {
    id: string;
    label: string;
    type: string;
    model?: string;
}

interface AiProfilesInfo {
    profiles: AiProfileSummary[];
    defaultProfile: string;
}

interface AiGenerateResult {
    ok: boolean;
    profileId: string;
    profileLabel: string;
    rules?: unknown;
    raw?: string;
    error?: string;
    /** 本次实际使用的会话 key(自检回路重生成时回传以复用同一 agent 会话) */
    sessionKey?: string;
    elapsedMs: number;
}

interface PauseEvent {
    runId: number;
    stepIndex: number;
    reason?: string;
    timeout?: number;
}

/** 浏览器登录态复用配置(与主进程 BrowserConfig 同构) */
interface BrowserConfig {
    persistProfile: boolean;
    userDataDir: string;
    injectRecordingSession: boolean;
    injectRecordingLocalStorage: boolean;
    useSystemChrome: boolean;
}

interface ElectronAPI {
    getWebviewPreloadPath(): Promise<string>;
    saveMacro(macro: Macro): Promise<string | null>;
    loadMacro(): Promise<Macro | null>;
    runMacro(macro: Macro): Promise<RunResult>;
    exportExcel(rows: Record<string, string>[]): Promise<string>;
    listPlugins(): Promise<PostProcessorManifest[]>;
    runPlugin(type: string): Promise<{ canceled?: boolean; results?: PostProcessResult[] }>;
    onLog(cb: (msg: LogMessage) => void): void;
    onMacroPaused(cb: (info: PauseEvent) => void): void;
    resumeMacro(runId: number): void;
    aiListProfiles(): Promise<AiProfilesInfo>;
    aiGenerateExtract(input: {
        requirement: string;
        html: string;
        profileId?: string;
        mode?: 'single' | 'list' | 'list-detail' | 'list-action';
        baseRules?: unknown;
        /** 上一轮选择器实测反馈(自检回路重生成时附带) */
        feedback?: string;
        /** 复用同一 agent 会话的 key(多轮修复保留上下文) */
        sessionKey?: string;
    }): Promise<AiGenerateResult>;
    importAiConfig(): Promise<{ ok: boolean; error?: string; canceled?: boolean; profileCount?: number }>;
    getBrowserConfig(): Promise<BrowserConfig>;
    setBrowserConfig(patch: Partial<BrowserConfig>): Promise<BrowserConfig>;
    chooseUserDataDir(): Promise<string | null>;
}

// <webview> 元素需要用到的 Electron 专有方法(DOM lib 未涵盖,这里最小声明)
interface WebviewElement extends HTMLElement {
    src: string;
    getURL(): string;
    send(channel: string, ...args: unknown[]): void;
    executeJavaScript(code: string): Promise<unknown>;
}

interface Window {
    electronAPI: ElectronAPI;
}

// ===== 默认提取规则模板(对应 books.toscrape.com,便于开箱即用) =====
const DEFAULT_EXTRACT = `{
    "mode": "list",
    "listSelector": ".product_pod",
    "fields": [
        { "name": "title", "selector": "h3 a", "type": "attr", "attr": "title" },
        { "name": "price", "selector": ".price_color", "type": "text" },
        { "name": "link", "selector": "h3 a", "type": "attr", "attr": "href" }
    ]
}`;

// ===== DOM 引用 =====
function byId<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
}

const addressInput = byId<HTMLInputElement>('address');
const nameInput = byId<HTMLInputElement>('macro-name');
const extractInput = byId<HTMLTextAreaElement>('extract');
const stepsEl = byId<HTMLDivElement>('steps');
const stepCountEl = byId<HTMLSpanElement>('step-count');
const logEl = byId<HTMLDivElement>('log');
const recIndicator = byId<HTMLSpanElement>('rec-indicator');
const webview = byId<HTMLElement>('view') as unknown as WebviewElement;

const openBtn = byId<HTMLButtonElement>('open');
const startBtn = byId<HTMLButtonElement>('start');
const stopBtn = byId<HTMLButtonElement>('stop');
const runBtn = byId<HTMLButtonElement>('run');
const saveBtn = byId<HTMLButtonElement>('save');
const loadBtn = byId<HTMLButtonElement>('load');
const addPauseBtn = byId<HTMLButtonElement>('add-pause');
const exportBtn = byId<HTMLButtonElement>('export');
const pauseOverlay = byId<HTMLDivElement>('pause-overlay');
const pauseReasonEl = byId<HTMLDivElement>('pause-reason');
const pauseContinueBtn = byId<HTMLButtonElement>('pause-continue');
const aiProfileSel = byId<HTMLSelectElement>('ai-profile');
const aiModeSel = byId<HTMLSelectElement>('ai-mode');
const aiRequirementInput = byId<HTMLTextAreaElement>('ai-requirement');
const aiGenerateBtn = byId<HTMLButtonElement>('ai-generate');
const aiImportBtn = byId<HTMLButtonElement>('ai-import');
const aiStatusEl = byId<HTMLSpanElement>('ai-status');
const aiDetailLinkRow = byId<HTMLDivElement>('ai-detail-link-row');
const aiDetailLinkFieldSel = byId<HTMLSelectElement>('ai-detail-link-field');

// ===== 状态 =====
let recording = false;
let steps: Step[] = [];
let lastRows: Record<string, string>[] = [];
// 元素拾取(通用「取选择器+回调」服务):pendingPick 保存当前这次拾取的消费回调,
// null 表示无进行中的拾取。用途由发起方通过回调决定(本文件 fingerprint 暂不消费,故用 unknown)。
type PickedHandler = (selector: string, fingerprint?: unknown) => void;
let pendingPick: PickedHandler | null = null;
// 已展开的连续滚动组——按「组首 step 对象引用」记录;默认折叠(不在集合里即折叠)。
// 用对象引用而非下标:step 对象在 splice/push 中保持身份不变,插入/删除/拖拽后仍能命中;
// 加载新宏时整个 steps 数组被替换为新对象,旧记录自动被 GC。
const expandedScrollGroups = new WeakSet<Step>();

// ===== 日志 =====
function appendLog(message: string, level: 'info' | 'error', time?: string): void {
    const t = time ?? new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = document.createElement('div');
    line.className = level === 'error' ? 'log-error' : 'log-info';
    line.textContent = `[${t}] ${message}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

function logLocal(message: string, level: 'info' | 'error' = 'info'): void {
    appendLog(message, level);
}

// ===== 步骤展示 =====
function describeStep(step: Step): string {
    const s = step as Record<string, unknown>;
    switch (step.type) {
        case 'goto':
            return `goto ${s.url}`;
        case 'click':
            return `click ${s.selector}`;
        case 'fill':
            return `fill ${s.selector} = "${s.value}"`;
        case 'press':
            return `press ${s.key}${s.selector ? ' @ ' + s.selector : ''}`;
        case 'scroll':
            return `scroll (${s.x}, ${s.y})`;
        case 'scroll-bottom':
            return '滚动到底部';
        case 'wait-for-load':
            return '等待页面加载完成';
        case 'waitForSelector':
            return `等待元素出现 ${s.selector}`;
        case 'waitForClickable':
            return `等待元素可点击 ${s.selector}`;
        case 'pause':
            return `人工介入暂停${s.reason ? ' — ' + s.reason : ''}${s.timeout ? '(超时 ' + s.timeout + 'ms)' : ''}`;
        default:
            return step.type;
    }
}

/** 创建单个步骤行 div(含文本、徽标、右键菜单、拖拽排序),事件均绑定真实下标 i */
function createStepLine(step: Step, i: number): HTMLDivElement {
    const div = document.createElement('div');
    div.className = 'step-line';
    div.textContent = `${i + 1}. ${describeStep(step)}`;
    // 翻页标记:加高亮 class 与行尾徽标
    if (step.pagination === true) {
        div.classList.add('pagination-marked');
        const badge = document.createElement('span');
        badge.className = 'pagination-badge';
        const pages = typeof step.pageCount === 'number' ? step.pageCount : 1;
        badge.textContent = `翻页 · 共${pages}页`;
        div.appendChild(badge);
    }
    // 人工介入暂停步骤:加高亮 class 与行尾徽标
    if (step.type === 'pause') {
        div.classList.add('pause-marked');
        const badge = document.createElement('span');
        badge.className = 'pause-badge';
        badge.textContent = '人工介入';
        div.appendChild(badge);
    }
    // 右键弹出操作菜单
    div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showStepContextMenu(e.clientX, e.clientY, i);
    });
    // 拖拽排序:每一行可上下拖动调整顺序
    div.draggable = true;
    div.dataset.index = String(i);
    div.addEventListener('dragstart', (e) => {
        dragFromIndex = i;
        div.classList.add('dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(i)); // 兼容部分浏览器要求有数据才触发 drop
        }
    });
    div.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
        }
        if (dragFromIndex === null || dragFromIndex === i) {
            return; // 拖到自身不显示指示线
        }
        clearDropIndicators();
        const rect = div.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        div.classList.add(before ? 'drop-before' : 'drop-after');
    });
    div.addEventListener('dragleave', () => {
        div.classList.remove('drop-before', 'drop-after');
    });
    div.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragFromIndex === null) {
            return;
        }
        const rect = div.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        const to = before ? i : i + 1; // 插入到目标行之前/之后
        moveStep(dragFromIndex, to);
    });
    div.addEventListener('dragend', () => {
        div.classList.remove('dragging');
        clearDropIndicators();
        dragFromIndex = null;
    });
    return div;
}

/** 是否为可并入折叠组的滚动步骤(翻页标记的滚动单独成行,避免折叠时隐藏翻页徽标) */
function isGroupableScroll(step: Step): boolean {
    return step.type === 'scroll' && step.pagination !== true;
}

function renderSteps(): void {
    stepsEl.innerHTML = '';
    let i = 0;
    while (i < steps.length) {
        const step = steps[i];
        // 连续滚动折叠:探测从 i 起的连续可分组滚动 [i, end)
        if (isGroupableScroll(step)) {
            let end = i + 1;
            while (end < steps.length && isGroupableScroll(steps[end])) {
                end++;
            }
            const groupLen = end - i;
            if (groupLen >= 2) {
                const expanded = expandedScrollGroups.has(step); // 以组首对象引用为锚
                const head = createStepLine(step, i);
                head.classList.add('scroll-group-head');
                const toggle = document.createElement('span');
                toggle.className = 'scroll-group-toggle';
                toggle.textContent = expanded ? `收起 ${groupLen} 条 ▴` : `连续滚动 ${groupLen} 条 ▾`;
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation(); // 不触发拖拽等行为
                    if (expanded) {
                        expandedScrollGroups.delete(step);
                    } else {
                        expandedScrollGroups.add(step);
                    }
                    renderSteps();
                });
                head.appendChild(toggle);
                stepsEl.appendChild(head);
                // 展开态:逐条渲染后续滚动子项(缩进、淡色)
                if (expanded) {
                    for (let j = i + 1; j < end; j++) {
                        const sub = createStepLine(steps[j], j);
                        sub.classList.add('scroll-group-item');
                        stepsEl.appendChild(sub);
                    }
                }
                i = end;
                continue;
            }
        }
        // 普通步骤(含单条滚动):正常单行渲染
        stepsEl.appendChild(createStepLine(step, i));
        i++;
    }
    stepCountEl.textContent = String(steps.length);
}

// ===== 步骤拖拽排序 =====
let dragFromIndex: number | null = null;

/** 清除所有步骤行上的拖放指示类 */
function clearDropIndicators(): void {
    stepsEl.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
        el.classList.remove('drop-before', 'drop-after');
    });
}

/** 把第 from 步移动到目标插入位置 to(to 为移除前的目标下标) */
function moveStep(from: number, to: number): void {
    if (from < 0 || from >= steps.length) {
        return;
    }
    const dest = from < to ? to - 1 : to; // 移除后修正目标下标
    if (dest === from) {
        return; // 原地不动
    }
    const [item] = steps.splice(from, 1);
    steps.splice(dest, 0, item);
    renderSteps();
    logLocal(`已将步骤 #${from + 1} 移动到第 ${dest + 1} 步。`);
}

// ===== 步骤右键菜单 =====
let ctxMenuEl: HTMLDivElement | null = null;

function closeStepContextMenu(): void {
    if (ctxMenuEl) {
        ctxMenuEl.remove();
        ctxMenuEl = null;
        document.removeEventListener('mousedown', onDocMouseDownForMenu, true);
        document.removeEventListener('keydown', onKeyDownForMenu, true);
    }
}

function onDocMouseDownForMenu(e: MouseEvent): void {
    if (ctxMenuEl && !ctxMenuEl.contains(e.target as Node)) {
        closeStepContextMenu();
    }
}

function onKeyDownForMenu(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        closeStepContextMenu();
    }
}

function showStepContextMenu(x: number, y: number, index: number): void {
    closeStepContextMenu();
    const step = steps[index];
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    // pause 步骤不提供翻页标记(回放主循环会跳过带 pagination 的步骤,二者互斥)
    if (step.type === 'pause') {
        const editPause = makeMenuItem('✏️', '修改暂停提示文案', () => {
            showPauseReasonInput(menu, index);
        });
        menu.appendChild(editPause);
    } else if (step.pagination === true) {
        // 已标记:提供「修改总页数」与「取消翻页标记」
        const current = typeof step.pageCount === 'number' ? step.pageCount : 1;
        const editItem = makeMenuItem('✏️', `修改翻页总页数(当前 ${current})`, () => {
            showPageCountInput(menu, index);
        });
        const unmarkItem = makeMenuItem('❌', '取消翻页标记', () => {
            delete steps[index].pagination;
            delete steps[index].pageCount;
            closeStepContextMenu();
            renderSteps();
            logLocal(`步骤 #${index + 1} 已取消翻页标记。`);
        });
        menu.appendChild(editItem);
        menu.appendChild(unmarkItem);
    } else {
        const markItem = makeMenuItem('🔖', '标记翻页操作', () => {
            showPageCountInput(menu, index);
        });
        menu.appendChild(markItem);
    }

    // 任意步骤都可在其前/后插入人工介入暂停步骤
    menu.appendChild(makeMenuItem('⏸️', '在此前插入暂停', () => {
        insertPause(index);
    }));
    menu.appendChild(makeMenuItem('⏸️', '在此后插入暂停', () => {
        insertPause(index + 1);
    }));
    // 在此后添加「滚动到底部」步骤(用于触发无限滚动懒加载)
    menu.appendChild(makeMenuItem('⬇️', '在此后添加滚动到底部', () => {
        insertScrollBottom(index + 1);
    }));
    // 在此后添加「等待页面加载完成」步骤
    menu.appendChild(makeMenuItem('⏳', '在此后添加等待页面加载完成', () => {
        insertWaitForLoad(index + 1);
    }));
    // 在此后添加「等待元素出现」步骤(在浏览器里点选目标元素)
    menu.appendChild(makeMenuItem('🎯', '在此后添加等待元素出现(点选)', () => {
        const at = index + 1;
        closeStepContextMenu();
        requestPick((selector) => insertWaitForSelector(at, selector));
    }));
    // 在此后添加「等待元素可点击」步骤(比「出现」更强:等到可交互;点选目标元素)
    menu.appendChild(makeMenuItem('🖱️', '在此后添加等待元素可点击(点选)', () => {
        const at = index + 1;
        closeStepContextMenu();
        requestPick((selector) => insertWaitForClickable(at, selector));
    }));
    // 仅带选择器的步骤(click/fill/waitForSelector/带 selector 的 press)可「重新点选」修正
    if (typeof step.selector === 'string' && step.selector) {
        const target = step; // 捕获对象引用:拾取异步期间即使排序变化也能定位到正确步骤
        menu.appendChild(makeMenuItem('🎯', '重新点选此步骤的选择器', () => {
            closeStepContextMenu();
            requestPick((selector, fingerprint) => {
                const i = steps.indexOf(target);
                if (i < 0) {
                    logLocal('该步骤已不存在,选择器未更新。', 'error');
                    return;
                }
                target.selector = selector;
                // click 步骤的语义指纹须与新选择器同步,否则回放重定位会依据旧元素走偏
                if (target.type === 'click') {
                    target.fingerprint = fingerprint;
                }
                renderSteps();
                logLocal(`步骤 #${i + 1} 的选择器已更新为:${selector}`);
            });
        }));
    }
    // 删除当前步骤
    menu.appendChild(makeMenuItem('🗑️', '删除此步骤', () => {
        steps.splice(index, 1);
        closeStepContextMenu();
        renderSteps();
        logLocal(`已删除步骤 #${index + 1}。`);
    }));

    document.body.appendChild(menu);
    ctxMenuEl = menu;
    // 防止超出视口右/下边界
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = `${Math.max(0, window.innerWidth - rect.width)}px`;
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = `${Math.max(0, window.innerHeight - rect.height)}px`;
    }
    document.addEventListener('mousedown', onDocMouseDownForMenu, true);
    document.addEventListener('keydown', onKeyDownForMenu, true);
}

function makeMenuItem(icon: string, label: string, onClick: () => void): HTMLDivElement {
    const item = document.createElement('div');
    item.className = 'ctx-menu-item';
    const ico = document.createElement('span');
    ico.className = 'ctx-menu-icon';
    ico.textContent = icon;
    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(ico);
    item.appendChild(text);
    item.addEventListener('click', onClick);
    return item;
}

/** 在菜单内显示总页数输入框(Electron 禁用原生 prompt,故用自定义 DOM) */
function showPageCountInput(menu: HTMLDivElement, index: number): void {
    menu.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'ctx-menu-input';

    const label = document.createElement('div');
    label.className = 'ctx-menu-label';
    label.textContent = '总页数(共采集 N 页):';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    const existing = typeof steps[index].pageCount === 'number' ? (steps[index].pageCount as number) : 2;
    input.value = String(existing);

    const confirm = (): void => {
        const n = Math.max(1, Math.floor(Number(input.value) || 1));
        steps[index].pagination = true;
        steps[index].pageCount = n;
        closeStepContextMenu();
        renderSteps();
        logLocal(`步骤 #${index + 1} 已标记为翻页,总页数 ${n}。`);
    };

    const okBtn = document.createElement('button');
    okBtn.textContent = '确定';
    okBtn.addEventListener('click', confirm);

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            confirm();
        }
    });

    wrap.appendChild(label);
    wrap.appendChild(input);
    wrap.appendChild(okBtn);
    menu.appendChild(wrap);
    input.focus();
    input.select();
}

/** 在菜单内显示暂停提示文案输入框 */
function showPauseReasonInput(menu: HTMLDivElement, index: number): void {
    menu.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'ctx-menu-input';

    const label = document.createElement('div');
    label.className = 'ctx-menu-label';
    label.textContent = '暂停提示文案(可留空):';

    const input = document.createElement('input');
    input.type = 'text';
    input.style.width = '180px';
    input.value = typeof steps[index].reason === 'string' ? (steps[index].reason as string) : '';

    const confirm = (): void => {
        const reason = input.value.trim();
        if (reason) {
            steps[index].reason = reason;
        } else {
            delete steps[index].reason;
        }
        closeStepContextMenu();
        renderSteps();
        logLocal(`步骤 #${index + 1} 暂停提示已更新。`);
    };

    const okBtn = document.createElement('button');
    okBtn.textContent = '确定';
    okBtn.addEventListener('click', confirm);

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            confirm();
        }
    });

    wrap.appendChild(label);
    wrap.appendChild(input);
    wrap.appendChild(okBtn);
    menu.appendChild(wrap);
    input.focus();
    input.select();
}

/** 在指定位置插入一个人工介入暂停步骤 */
function insertPause(at: number): void {
    const clamped = Math.max(0, Math.min(at, steps.length));
    steps.splice(clamped, 0, { type: 'pause' });
    closeStepContextMenu();
    renderSteps();
    logLocal(`已在第 ${clamped + 1} 步位置插入人工介入暂停(可右键修改提示文案)。`);
}

function insertScrollBottom(at: number): void {
    const clamped = Math.max(0, Math.min(at, steps.length));
    steps.splice(clamped, 0, { type: 'scroll-bottom' });
    closeStepContextMenu();
    renderSteps();
    logLocal(`已在第 ${clamped + 1} 步位置添加「滚动到底部」(回放时滚到页面最底部以触发懒加载)。`);
}

function insertWaitForLoad(at: number): void {
    const clamped = Math.max(0, Math.min(at, steps.length));
    steps.splice(clamped, 0, { type: 'wait-for-load' });
    closeStepContextMenu();
    renderSteps();
    logLocal(`已在第 ${clamped + 1} 步位置添加「等待页面加载完成」(回放时等 load 事件后继续)。`);
}

// 通用拾取服务:进入拾取模式,选中元素后把选择器交给发起方登记的回调(用途与拾取解耦)。
function requestPick(onPicked: PickedHandler): void {
    pendingPick = onPicked;
    // 拾取期间临时挂起录制,避免拾取的点击被误录(picker 已 preventDefault,这里再加一层稳妥)
    if (recording) {
        armRecorder(false);
    }
    try {
        webview.send('toggle-picker', true);
    } catch {
        // 页面尚未就绪,回滚状态
        pendingPick = null;
        if (recording) {
            armRecorder(true);
        }
        logLocal('页面尚未就绪,无法进入元素拾取模式。', 'error');
        return;
    }
    logLocal('拾取模式已开启:请在页面中点击目标元素,按 ESC 取消。');
}

function insertWaitForSelector(at: number, selector: string): void {
    const clamped = Math.max(0, Math.min(at, steps.length));
    steps.splice(clamped, 0, { type: 'waitForSelector', selector });
    renderSteps();
    logLocal(`已在第 ${clamped + 1} 步位置添加「等待元素出现」:${selector}`);
}

function insertWaitForClickable(at: number, selector: string): void {
    const clamped = Math.max(0, Math.min(at, steps.length));
    steps.splice(clamped, 0, { type: 'waitForClickable', selector });
    renderSteps();
    logLocal(`已在第 ${clamped + 1} 步位置添加「等待元素可点击」:${selector}`);
}

function addStep(step: Step): void {
    steps.push(step);
    renderSteps();
    logLocal(`录制步骤 #${steps.length}:${describeStep(step)}`);
}

// ===== 录制 UI 状态 =====
function setRecordingUI(on: boolean): void {
    startBtn.disabled = on;
    stopBtn.disabled = !on;
    recIndicator.textContent = on ? '● 录制中' : '未录制';
    recIndicator.className = on ? 'rec-indicator on' : 'rec-indicator';
}

function setBusy(busy: boolean): void {
    runBtn.disabled = busy;
    runBtn.textContent = busy ? '运行中…' : '运行宏';
}

// ===== 人工介入暂停模态框 =====
let currentPauseRunId: number | null = null;

function showPauseModal(info: PauseEvent): void {
    currentPauseRunId = info.runId;
    pauseReasonEl.textContent =
        info.reason && info.reason.trim()
            ? info.reason
            : `回放执行到第 ${info.stepIndex + 1} 步,需要人工操作。`;
    pauseOverlay.classList.add('show');
    logLocal(`回放已暂停(第 ${info.stepIndex + 1} 步),等待人工操作……`);
}

function hidePauseModal(): void {
    pauseOverlay.classList.remove('show');
    currentPauseRunId = null;
}

pauseContinueBtn.addEventListener('click', () => {
    if (currentPauseRunId !== null) {
        window.electronAPI.resumeMacro(currentPauseRunId);
        logLocal('已点击「继续」,恢复回放。');
    }
    hidePauseModal();
});

// ===== webview 操作 =====
function normalizeUrl(input: string): string {
    const v = input.trim();
    if (!v) {
        return '';
    }
    if (/^(https?:|about:|file:)/i.test(v)) {
        return v;
    }
    return 'https://' + v;
}

function safeGetUrl(): string {
    try {
        return webview.getURL();
    } catch {
        return '';
    }
}

function armRecorder(on: boolean): void {
    try {
        webview.send('toggle-recording', on);
    } catch {
        // 页面尚未就绪;dom-ready 时会再次发送
    }
}

// ===== 宏组装 =====
function buildMacro(): Macro {
    const name = nameInput.value.trim() || 'untitled-macro';
    const macro: Macro = { name, version: 1, steps };
    const raw = extractInput.value.trim();
    if (raw) {
        macro.extract = JSON.parse(raw); // 解析失败由调用方捕获
    }
    // 勾选的插件写入 postProcess(随宏保存),回放产出后由主进程依次执行
    const picked = selectedPluginTypes();
    if (picked.length > 0) {
        macro.postProcess = picked.map((type) => ({ type }));
    }
    return macro;
}

/**
 * 解析「提取规则」框,返回可作为 list-detail 基础的规则对象;不合法返回 null。
 * 接受 mode=list 或 mode=list-detail(两者都含 listSelector + fields,均可作 list-detail 基础);
 * 这样加载本就是 list-detail 的宏后,list-detail 选项与详情入口字段下拉也能正常启用/填充。
 */
function parseValidListRules(): Record<string, unknown> | null {
    const raw = extractInput.value.trim();
    if (!raw) {
        return null;
    }
    try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (
            obj &&
            (obj.mode === 'list' || obj.mode === 'list-detail') &&
            typeof obj.listSelector === 'string' &&
            obj.listSelector.trim() &&
            Array.isArray(obj.fields)
        ) {
            return obj;
        }
    } catch {
        // 解析失败按不合法处理
    }
    return null;
}

// list-detail 选项:无合法 list 规则前提时直接禁用,而非选后报错回退
const aiListDetailOption = aiModeSel.querySelector<HTMLOptionElement>('option[value="list-detail"]')!;
const LIST_DETAIL_LABEL = '列表+详情(list-detail)';

/**
 * 详情页入口字段下拉:仅在 list-detail 模式显示,选项来自现有 list 规则的 fields[].name。
 * 用户选定后由生成流程写入 detailLinkField(取代 AI 生成的 detailLinkSelector)。
 * 刷新时尽量保留当前选中项,避免编辑规则框时选择被重置。
 */
function refreshDetailLinkFieldOptions(): void {
    const isListDetail = aiModeSel.value === 'list-detail';
    aiDetailLinkRow.style.display = isListDetail ? '' : 'none';
    if (!isListDetail) {
        return;
    }
    const base = parseValidListRules();
    const fields = base && Array.isArray(base.fields) ? (base.fields as Array<{ name?: unknown }>) : [];
    const names = fields
        .map((f) => (f && typeof f.name === 'string' ? f.name : ''))
        .filter((n) => n);
    const prev = aiDetailLinkFieldSel.value;
    aiDetailLinkFieldSel.innerHTML = '';
    for (const name of names) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        aiDetailLinkFieldSel.appendChild(opt);
    }
    // 选定优先级:沿用当前选中 → 回显已加载规则里的 detailLinkField → 默认第一项
    const loaded =
        typeof base?.detailLinkField === 'string' ? (base.detailLinkField as string) : '';
    if (prev && names.includes(prev)) {
        aiDetailLinkFieldSel.value = prev;
    } else if (loaded && names.includes(loaded)) {
        aiDetailLinkFieldSel.value = loaded;
    }
}

/** 依据「提取规则」框是否为合法 list 规则,启用/禁用 list-detail 选项 */
function refreshAiModeOptions(): void {
    const ready = parseValidListRules() !== null;
    aiListDetailOption.disabled = !ready;
    aiListDetailOption.textContent = ready
        ? LIST_DETAIL_LABEL
        : `${LIST_DETAIL_LABEL} — 需先填合法 list 规则`;
    // 前提失效且当前正选中 list-detail 时,回退到 list
    if (!ready && aiModeSel.value === 'list-detail') {
        aiModeSel.value = 'list';
    }
    refreshDetailLinkFieldOptions();
}

// 用户手动编辑「提取规则」框时,实时联动 list-detail 选项可用性与详情入口字段下拉
extractInput.addEventListener('input', refreshAiModeOptions);
// 切换目标模式时刷新详情入口字段下拉的显隐与选项
aiModeSel.addEventListener('change', refreshDetailLinkFieldOptions);

// ===== 按钮事件 =====
openBtn.addEventListener('click', () => {
    const url = normalizeUrl(addressInput.value);
    if (!url) {
        logLocal('请输入网址。', 'error');
        return;
    }
    addressInput.value = url;
    webview.src = url;
    logLocal(`打开网页:${url}`);
    if (recording) {
        addStep({ type: 'goto', url });
    }
});

addressInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        openBtn.click();
    }
});

startBtn.addEventListener('click', () => {
    // 保留现场:不再清空已有步骤,新动作追加到末尾
    const url = safeGetUrl();
    if (url && url !== 'about:blank') {
        // 取已录制步骤中最后一条 goto 的 url,做去重
        let lastGotoUrl: string | undefined;
        for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i].type === 'goto') {
                lastGotoUrl = (steps[i] as { url?: string }).url;
                break;
            }
        }
        // steps 为空 → 补首个 goto;非空 → 仅当当前页与上次跳转目标不同才补
        if (steps.length === 0 || lastGotoUrl !== url) {
            addStep({ type: 'goto', url });
        }
    }
    recording = true;
    armRecorder(true);
    setRecordingUI(true);
    logLocal('开始录制。请在页面中点击 / 输入 / 回车 / 滚动。');
});

stopBtn.addEventListener('click', () => {
    recording = false;
    armRecorder(false);
    setRecordingUI(false);
    logLocal(`停止录制,共记录 ${steps.length} 个步骤。`);
});

/** 统一处理回放结果的日志反馈(供「运行」按钮与插件面板共用) */
function reportRunResult(result: RunResult): void {
    if (result.ok) {
        lastRows = result.rows ?? [];
        const dlCount = result.downloads?.length ?? 0;
        if (dlCount > 0) {
            // list-action 等模式:产出是下载文件而非数据行
            logLocal(`运行成功,已下载 ${dlCount} 个文件(已在文件管理器中定位)。`);
        } else {
            logLocal(`运行成功,提取到 ${lastRows.length} 行数据。可点击「导出 Excel」。`);
        }
        // 后处理器结果(如下载后合并 zip 内 excel)逐条提示
        for (const pp of result.postProcessed ?? []) {
            logLocal(`后处理「${pp.type}」:${pp.message}`);
        }
    } else {
        const err = result.error;
        logLocal(
            `运行失败:第 ${(err?.stepIndex ?? -1) + 1} 步(${err?.stepType})` +
                `${err?.selector ? ' selector=' + err.selector : ''}` +
                ` URL=${err?.url ?? '未知'} 原因:${err?.message}`,
            'error'
        );
    }
}

runBtn.addEventListener('click', async () => {
    let macro: Macro;
    try {
        macro = buildMacro();
    } catch (e) {
        logLocal('提取规则不是合法 JSON:' + (e as Error).message, 'error');
        return;
    }
    if (macro.steps.length === 0) {
        logLocal('当前没有任何步骤,请先录制或加载宏。', 'error');
        return;
    }
    setBusy(true);
    logLocal('提交运行宏……(将弹出 Playwright 浏览器窗口)');
    try {
        const result = await window.electronAPI.runMacro(macro);
        reportRunResult(result);
    } catch (e) {
        logLocal('运行宏异常:' + (e as Error).message, 'error');
    } finally {
        setBusy(false);
        hidePauseModal(); // 清理可能残留的暂停模态框(如超时失败返回时)
    }
});

addPauseBtn.addEventListener('click', () => {
    insertPause(steps.length);
});

saveBtn.addEventListener('click', async () => {
    let macro: Macro;
    try {
        macro = buildMacro();
    } catch (e) {
        logLocal('提取规则不是合法 JSON,无法保存:' + (e as Error).message, 'error');
        return;
    }
    try {
        const filePath = await window.electronAPI.saveMacro(macro);
        if (filePath) {
            logLocal(`宏已保存到:${filePath}`);
        }
    } catch (e) {
        logLocal('保存宏失败:' + (e as Error).message, 'error');
    }
});

loadBtn.addEventListener('click', async () => {
    let macro: Macro | null = null;
    try {
        macro = await window.electronAPI.loadMacro();
    } catch (e) {
        logLocal('加载宏失败:' + (e as Error).message, 'error');
        return;
    }
    if (!macro) {
        return;
    }
    nameInput.value = macro.name ?? '';
    steps = Array.isArray(macro.steps) ? (macro.steps as Step[]) : [];
    renderSteps();
    if (macro.extract) {
        extractInput.value = JSON.stringify(macro.extract, null, 4);
        // 目标模式下拉同步成已加载 extract 的模式(让 list-detail 宏加载后即回显该模式)。
        // 须先放宽判定(parseValidListRules 已接受 list-detail)再设值,避免被「不可用即回退」打回。
        const loadedMode = (macro.extract as { mode?: string }).mode;
        if (
            loadedMode === 'single' ||
            loadedMode === 'list' ||
            loadedMode === 'list-detail' ||
            loadedMode === 'list-action'
        ) {
            aiModeSel.value = loadedMode;
        }
        refreshAiModeOptions();
    } else {
        // 宏无提取规则:显式清空,避免残留 init() 预填的 DEFAULT_EXTRACT
        extractInput.value = '';
        refreshAiModeOptions();
    }
    // 回显宏里启用的插件勾选
    refreshPluginSelection(macro.postProcess);
    logLocal(
        `已加载宏「${macro.name}」,${steps.length} 个步骤。` +
            (macro.extract ? ' 已填充提取规则。' : '')
    );

    // 若首步是 goto,顺便在内置浏览器打开,便于查看
    const first = steps[0] as Record<string, unknown> | undefined;
    if (first && first.type === 'goto' && typeof first.url === 'string') {
        addressInput.value = first.url;
        webview.src = first.url;
    }
});

exportBtn.addEventListener('click', async () => {
    if (lastRows.length === 0) {
        logLocal('暂无可导出的数据,请先运行宏并成功提取数据。', 'error');
        return;
    }
    try {
        const filePath = await window.electronAPI.exportExcel(lastRows);
        if (!filePath) {
            logLocal('已取消导出。');
            return;
        }
        logLocal(`Excel 已导出到:${filePath}`);
    } catch (e) {
        logLocal('导出 Excel 失败:' + (e as Error).message, 'error');
    }
});

// ===== 提取规则面板折叠(默认收起,点标题展开/收起) =====
const extractPanel = byId<HTMLDivElement>('extract-panel');
const extractTitle = byId<HTMLElement>('extract-title');
extractTitle.addEventListener('click', () => {
    extractPanel.classList.toggle('collapsed');
});

// ===== AI 提取面板折叠(点标题展开/收起) =====
const aiPanel = byId<HTMLDivElement>('ai-panel');
const aiTitle = byId<HTMLElement>('ai-title');
aiTitle.addEventListener('click', () => {
    aiPanel.classList.toggle('collapsed');
});

// ===== 录制步骤面板折叠(点标题展开/收起) =====
const stepsPanel = byId<HTMLDivElement>('steps-panel');
const stepsTitle = byId<HTMLElement>('steps-title');
stepsTitle.addEventListener('click', () => {
    stepsPanel.classList.toggle('collapsed');
});

// ===== 插件:可选插件列表(由后端注册表驱动,勾选启用、随主「运行」一起执行) =====
const pluginPanel = byId<HTMLDivElement>('plugin-panel');
const pluginTitle = byId<HTMLElement>('plugin-title');
const pluginList = byId<HTMLDivElement>('plugin-list');

pluginTitle.addEventListener('click', () => {
    pluginPanel.classList.toggle('collapsed');
});

/** 从后端注册表拉取可用插件,渲成可勾选列表(空列表给出提示) */
async function loadPlugins(): Promise<void> {
    try {
        const plugins = await window.electronAPI.listPlugins();
        pluginList.innerHTML = '';
        if (plugins.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'hint';
            empty.textContent = '暂无可用插件。';
            pluginList.appendChild(empty);
            return;
        }
        for (const p of plugins) {
            // 一行:左侧勾选(随「运行」执行)+ 名称,右侧「直接运行」按钮(不跑宏、直接处理文件)
            const row = document.createElement('div');
            row.className = 'plugin-row';
            const label = document.createElement('label');
            label.className = 'plugin-item';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.dataset.pluginType = p.type;
            const name = document.createElement('span');
            name.textContent = p.label;
            label.appendChild(cb);
            label.appendChild(name);
            const runNow = document.createElement('button');
            runNow.className = 'plugin-run-now';
            runNow.textContent = '直接运行';
            runNow.title = '不跑宏,直接选 zip/csv/xls/xlsx 文件合并';
            runNow.addEventListener('click', () => void runPluginDirect(p.type, p.label));
            row.appendChild(label);
            row.appendChild(runNow);
            const desc = document.createElement('div');
            desc.className = 'plugin-desc';
            desc.textContent = p.description;
            pluginList.appendChild(row);
            pluginList.appendChild(desc);
        }
    } catch (e) {
        logLocal('加载插件列表失败:' + (e as Error).message, 'error');
    }
}

/** 直接运行某插件:弹文件夹选择(主进程),对其内文件直接处理,不跑宏 */
async function runPluginDirect(type: string, label: string): Promise<void> {
    setBusy(true);
    logLocal(`直接运行插件「${label}」:请选择要合并的文件(可多选 zip/csv/xls/xlsx)……`);
    try {
        const res = await window.electronAPI.runPlugin(type);
        if (res.canceled) {
            logLocal('已取消直接运行。');
        } else {
            for (const r of res.results ?? []) {
                logLocal(`后处理「${r.type}」:${r.message}`);
            }
        }
    } catch (e) {
        logLocal('直接运行插件异常:' + (e as Error).message, 'error');
    } finally {
        setBusy(false);
    }
}

/** 当前勾选启用的插件 type 列表 */
function selectedPluginTypes(): string[] {
    const boxes = pluginList.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-plugin-type]');
    const picked: string[] = [];
    boxes.forEach((cb) => {
        const type = cb.dataset.pluginType;
        if (cb.checked && type) {
            picked.push(type);
        }
    });
    return picked;
}

/** 依据宏的 postProcess 回显勾选(宏里有但当前未注册的 type 忽略) */
function refreshPluginSelection(postProcess: Macro['postProcess']): void {
    const wanted = new Set<string>(
        (Array.isArray(postProcess) ? postProcess : [])
            .map((p) => p?.type)
            .filter((t): t is string => !!t)
    );
    const boxes = pluginList.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-plugin-type]');
    boxes.forEach((cb) => {
        const type = cb.dataset.pluginType;
        cb.checked = !!type && wanted.has(type);
    });
}

// ===== 浏览器登录态(回放复用)=====
const browserPanel = byId<HTMLDivElement>('browser-panel');
const browserTitle = byId<HTMLElement>('browser-title');
const bcChrome = byId<HTMLInputElement>('bc-chrome');
const bcPersist = byId<HTMLInputElement>('bc-persist');
const bcInject = byId<HTMLInputElement>('bc-inject');
const bcLocalStorage = byId<HTMLInputElement>('bc-localstorage');
const bcDir = byId<HTMLSpanElement>('bc-dir');
const bcChooseBtn = byId<HTMLButtonElement>('bc-choose');
const bcDirRow = bcChooseBtn.parentElement as HTMLDivElement;

browserTitle.addEventListener('click', () => {
    browserPanel.classList.toggle('collapsed');
});

/** 把配置回填到三个控件,并依持久化开关联动目录行可用性 */
function applyBrowserConfig(cfg: BrowserConfig): void {
    bcChrome.checked = cfg.useSystemChrome;
    bcPersist.checked = cfg.persistProfile;
    bcInject.checked = cfg.injectRecordingSession;
    bcLocalStorage.checked = cfg.injectRecordingLocalStorage;
    bcDir.textContent = cfg.userDataDir;
    bcDir.title = cfg.userDataDir;
    // 未开启持久化时,目录显示与选择按钮置灰
    bcDirRow.classList.toggle('disabled', !cfg.persistProfile);
}

/** 加载并回填浏览器登录态配置 */
async function loadBrowserConfig(): Promise<void> {
    try {
        const cfg = await window.electronAPI.getBrowserConfig();
        applyBrowserConfig(cfg);
    } catch (e) {
        logLocal('加载浏览器登录态配置失败:' + (e as Error).message, 'error');
    }
}

bcChrome.addEventListener('change', async () => {
    const cfg = await window.electronAPI.setBrowserConfig({ useSystemChrome: bcChrome.checked });
    applyBrowserConfig(cfg);
});

bcPersist.addEventListener('change', async () => {
    const cfg = await window.electronAPI.setBrowserConfig({ persistProfile: bcPersist.checked });
    applyBrowserConfig(cfg);
});

bcInject.addEventListener('change', async () => {
    const cfg = await window.electronAPI.setBrowserConfig({
        injectRecordingSession: bcInject.checked,
    });
    applyBrowserConfig(cfg);
});

bcLocalStorage.addEventListener('change', async () => {
    const cfg = await window.electronAPI.setBrowserConfig({
        injectRecordingLocalStorage: bcLocalStorage.checked,
    });
    applyBrowserConfig(cfg);
});

bcChooseBtn.addEventListener('click', async () => {
    const dir = await window.electronAPI.chooseUserDataDir();
    if (!dir) {
        return; // 取消
    }
    const cfg = await window.electronAPI.setBrowserConfig({ userDataDir: dir });
    applyBrowserConfig(cfg);
    logLocal('已设置浏览器 profile 目录:' + dir);
});

// ===== AI 提取 =====
/** 加载配置档并填充下拉 */
async function loadAiProfiles(): Promise<void> {
    try {
        const info = await window.electronAPI.aiListProfiles();
        aiProfileSel.innerHTML = '';
        for (const p of info.profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.model ? `${p.label}(${p.model})` : p.label;
            if (p.id === info.defaultProfile) {
                opt.selected = true;
            }
            aiProfileSel.appendChild(opt);
        }
        if (info.profiles.length === 0) {
            logLocal('未找到 AI 配置档,请检查 ai-config.json。', 'error');
        }
    } catch (e) {
        logLocal('加载 AI 配置档失败:' + (e as Error).message, 'error');
    }
}

/** 取当前 webview 页面的完整 HTML */
async function getPageHtml(): Promise<string> {
    const result = await webview.executeJavaScript('document.documentElement.outerHTML');
    return typeof result === 'string' ? result : '';
}

function setAiBusy(busy: boolean): void {
    aiGenerateBtn.disabled = busy;
    aiGenerateBtn.textContent = busy ? 'AI 生成中…' : 'AI 生成规则';
    // 忙态时状态区显示旋转加载圆环
    aiStatusEl.classList.toggle('ai-loading', busy);
}

/** 单个选择器在录制 webview 内的实测结果 */
interface SelectorCheckResult {
    /** 展示用标签(如 listSelector / actionSelector / 字段「标题」) */
    key: string;
    selector: string;
    /** page=整页测;item=在首个列表项内测(镜像 extractor 的 item.locator(...).first()) */
    scope: 'page' | 'item';
    count: number;
    /** 选择器语法非法(querySelectorAll 抛错) */
    invalid: boolean;
    /** scope=item 但 listSelector 未命中、无列表项可测 */
    noItem?: boolean;
}

/**
 * 在录制 webview 内实测生成规则里的关键选择器命中数(DOM 与 AI 所见一致)。
 * 镜像 extractor 运行时语义:列表项内字段/动作/详情链接以「首个列表项」为根测。
 * 非法选择器记 invalid;执行失败返回空数组(不阻断生成,按非致命处理)。
 */
async function verifySelectors(rules: unknown): Promise<SelectorCheckResult[]> {
    const cfg = rules as {
        mode?: string;
        listSelector?: string;
        actionSelector?: string;
        detailLinkField?: string;
        fields?: Array<{ name?: string; selector?: string }>;
        detailFields?: Array<{ name?: string; selector?: string }>;
    };
    if (!cfg || typeof cfg !== 'object') {
        return [];
    }
    const checks: Array<{ key: string; selector: string; scope: 'page' | 'item' }> = [];
    const mode = cfg.mode;
    // 注入脚本据此整页测 listSelector 并取首项为根;list-detail 在详情页生成,无列表页可测,置空。
    let listSelector = typeof cfg.listSelector === 'string' ? cfg.listSelector.trim() : '';
    if (mode === 'list-detail') {
        // list-detail 规则在「详情页」上生成(AI 需读详情页 HTML 生成 detailFields)。
        // 列表页那套(listSelector/fields/详情入口)在生成 list 规则时已验过、详情页上必然 0 命中,
        // 故此处只在当前详情页整页校验 detailFields 是否命中,不再误验列表页选择器。
        listSelector = '';
        (cfg.detailFields ?? []).forEach((f) => {
            const sel = f && typeof f.selector === 'string' ? f.selector.trim() : '';
            if (sel) {
                checks.push({ key: `详情字段「${f.name ?? sel}」`, selector: sel, scope: 'page' });
            }
        });
    } else {
        // 字段选择器:single 在整页测,list 在项内测;留空=容器本身,跳过
        const fieldScope: 'page' | 'item' = mode === 'single' ? 'page' : 'item';
        (cfg.fields ?? []).forEach((f) => {
            const sel = f && typeof f.selector === 'string' ? f.selector.trim() : '';
            if (sel) {
                checks.push({ key: `字段「${f.name ?? sel}」`, selector: sel, scope: fieldScope });
            }
        });
        // 动作按钮:留空=点列表项本身,跳过
        if (
            mode === 'list-action' &&
            typeof cfg.actionSelector === 'string' &&
            cfg.actionSelector.trim()
        ) {
            checks.push({ key: 'actionSelector', selector: cfg.actionSelector.trim(), scope: 'item' });
        }
    }

    const params = { listSelector, checks };
    // 注入一段自执行脚本:整页测 listSelector,再以首个列表项为根测各项内选择器
    const code =
        '(function(){' +
        'var p=' + JSON.stringify(params) + ';' +
        'function sc(root,sel){try{return{count:root.querySelectorAll(sel).length};}catch(e){return{invalid:true};}}' +
        'var out=[];var item=null;' +
        'if(p.listSelector){var lr=sc(document,p.listSelector);' +
        'out.push({key:"listSelector",selector:p.listSelector,scope:"page",count:lr.count||0,invalid:!!lr.invalid});' +
        'if(!lr.invalid){try{item=document.querySelector(p.listSelector);}catch(e){item=null;}}}' +
        'p.checks.forEach(function(c){' +
        'if(c.scope==="item"&&!item){out.push({key:c.key,selector:c.selector,scope:c.scope,count:0,invalid:false,noItem:true});return;}' +
        'var root=c.scope==="item"?item:document;var r=sc(root,c.selector);' +
        'out.push({key:c.key,selector:c.selector,scope:c.scope,count:r.count||0,invalid:!!r.invalid});});' +
        'return out;})()';
    try {
        const raw = await webview.executeJavaScript(code);
        return Array.isArray(raw) ? (raw as SelectorCheckResult[]) : [];
    } catch (e) {
        logLocal('选择器实测执行失败(按非致命处理):' + (e as Error).message, 'error');
        return [];
    }
}

/** 把实测结果汇成一行中文摘要(日志用) */
function summarizeChecks(checks: SelectorCheckResult[]): string {
    if (!checks.length) {
        return '(无可测选择器)';
    }
    return checks
        .map((c) => {
            const where = c.scope === 'item' ? '项内' : '整页';
            if (c.invalid) return `${c.key}(${where})非法选择器`;
            if (c.noItem) return `${c.key}(${where})无列表项可测`;
            return `${c.key}(${where})命中 ${c.count}`;
        })
        .join(';');
}

/**
 * 判定实测是否通过,并在未通过时给出喂回 AI 的中文反馈。
 * 规则:listSelector 必须命中>0;任何非法选择器算失败;
 * 有 listSelector 且命中时,项内选择器需至少一个命中;single 模式各字段需至少一个命中。
 */
function evaluateChecks(checks: SelectorCheckResult[]): { passed: boolean; feedback: string } {
    const fails: string[] = [];
    const listCheck = checks.find((c) => c.key === 'listSelector');
    if (listCheck) {
        if (listCheck.invalid) {
            fails.push(`listSelector \`${listCheck.selector}\` 是非法选择器`);
        } else if (listCheck.count === 0) {
            fails.push(`listSelector \`${listCheck.selector}\` 在当前页命中 0 个列表项`);
        }
    }
    // 非法的项内/整页选择器一律算失败
    checks
        .filter((c) => c.key !== 'listSelector' && c.invalid)
        .forEach((c) => fails.push(`${c.key} \`${c.selector}\` 是非法选择器`));

    const itemChecks = checks.filter((c) => c.scope === 'item');
    const listOk = !listCheck || (!listCheck.invalid && listCheck.count > 0);
    if (listOk && itemChecks.length > 0) {
        const anyHit = itemChecks.some((c) => !c.invalid && !c.noItem && c.count > 0);
        if (!anyHit) {
            const det = itemChecks.map((c) => `${c.key} \`${c.selector}\` 命中 0`).join(';');
            fails.push(`列表项内的选择器全部 0 命中(${det})`);
        }
    }
    // single 模式无 listSelector,各整页字段需至少一个命中
    if (!listCheck) {
        const pageChecks = checks.filter((c) => c.scope === 'page');
        if (pageChecks.length > 0 && !pageChecks.some((c) => !c.invalid && c.count > 0)) {
            fails.push('所有字段选择器在当前页 0 命中');
        }
    }

    if (!fails.length) {
        return { passed: true, feedback: '' };
    }
    const feedback = [
        '本轮各选择器实测:' + summarizeChecks(checks),
        '需修正:',
        ...fails.map((f) => '- ' + f),
        '请保持已命中的选择器尽量不变,只修正上面命中 0 / 非法的选择器,重新输出完整规则 JSON。',
    ].join('\n');
    return { passed: false, feedback };
}

aiGenerateBtn.addEventListener('click', async () => {
    const url = safeGetUrl();
    if (!url || url === 'about:blank') {
        logLocal('请先在上方打开一个网页,再用 AI 生成规则。', 'error');
        return;
    }
    let html = '';
    try {
        html = await getPageHtml();
    } catch (e) {
        logLocal('获取页面 HTML 失败:' + (e as Error).message, 'error');
        return;
    }
    if (!html) {
        logLocal('当前页面 HTML 为空,无法生成规则。', 'error');
        return;
    }

    const requirement = aiRequirementInput.value.trim();
    const profileId = aiProfileSel.value || undefined;
    const mode = aiModeSel.value as 'single' | 'list' | 'list-detail' | 'list-action';

    // list-detail 必须以现有合法 list 规则为基础;生成时兜底校验
    let baseRules: Record<string, unknown> | undefined;
    let detailLinkField = '';
    if (mode === 'list-detail') {
        const base = parseValidListRules();
        if (!base) {
            logLocal('「列表+详情」模式需要先在「提取规则」框中填入合法的 mode=list 规则(含 listSelector 与 fields),生成已取消。', 'error');
            return;
        }
        // 基础可能本就是 list-detail(加载旧宏后),归一为 list 形再喂 agent,
        // 避免把 detailFields/detailLinkField 当作「现有 list 规则」干扰提示词。
        baseRules =
            base.mode === 'list-detail'
                ? { mode: 'list', listSelector: base.listSelector, fields: base.fields }
                : base;
        // 详情入口字段由用户从 fields 中选定(取代 AI 生成的详情链接选择器)
        detailLinkField = aiDetailLinkFieldSel.value || '';
        if (!detailLinkField) {
            logLocal('「列表+详情」模式需要先在「详情页入口字段」下拉中选择一个指向详情页链接的字段,生成已取消。', 'error');
            return;
        }
    }

    aiStatusEl.classList.remove('ok', 'err');
    setAiBusy(true);
    aiStatusEl.textContent = '正在请求 AI,请稍候……';
    logLocal(`AI 提取:已抓取页面 HTML(${html.length} 字符),目标模式「${mode}」,提交「${profileId ?? '默认'}」生成规则……`);
    try {
        // 自检回路:生成 → 在录制 webview 内实测选择器 → 未命中则带反馈复用同一会话重生成
        const maxAttempts = 3; // 首轮 + 最多 2 次修复
        let feedback: string | undefined;
        let sessionKey: string | undefined;
        let lastRules: unknown = null;
        let lastLabel = '';
        let lastChecks: SelectorCheckResult[] = [];
        let passed = false;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (attempt > 1) {
                aiStatusEl.textContent = `选择器实测未通过,正在反馈重生成(第 ${attempt - 1} 次修复)……`;
                logLocal(`选择器实测未全部命中,带反馈请求 AI 修正(第 ${attempt - 1} 次)……`);
            }
            const res = await window.electronAPI.aiGenerateExtract({
                requirement,
                html,
                profileId,
                mode,
                baseRules,
                feedback,
                sessionKey,
            });
            if (!res.ok || !res.rules) {
                // 生成本身失败(网络/解析等):不再重试,直接报错退出
                aiStatusEl.classList.add('err');
                aiStatusEl.textContent = '生成失败,详见日志。';
                logLocal(`AI 提取失败:${res.error ?? '未知错误'}`, 'error');
                if (res.raw) {
                    logLocal('模型原始回复:' + res.raw.slice(0, 500), 'error');
                }
                return; // finally 复位忙态
            }
            sessionKey = res.sessionKey ?? sessionKey; // 复用同一 agent 会话,保留修复上下文
            lastRules = res.rules;
            lastLabel = res.profileLabel;

            // list-detail:把用户选定的详情入口字段写入规则(AI 不再生成详情链接),
            // 并清掉模型可能误输出的旧字段,保证实测与落地的都是新结构。
            if (mode === 'list-detail' && lastRules && typeof lastRules === 'object') {
                const r = lastRules as Record<string, unknown>;
                r.detailLinkField = detailLinkField;
                delete r.detailLinkSelector;
            }

            const checks = await verifySelectors(lastRules);
            lastChecks = checks;
            logLocal('选择器实测:' + summarizeChecks(checks));
            const evald = evaluateChecks(checks);
            if (evald.passed) {
                passed = true;
                break;
            }
            feedback = evald.feedback;
        }

        // 落地:无论是否通过都填入最后一版(失败不致命,便于人工接力修改)
        if (lastRules) {
            extractInput.value = JSON.stringify(lastRules, null, 4);
            refreshAiModeOptions();
        }
        // list-detail:本次在详情页只校验 detailFields;详情入口字段在回放(列表页)时按其
        // selector 取 href 生效,此处无列表页可测,故只作 info 说明,不再误报「取不到 href」。
        if (mode === 'list-detail') {
            logLocal(
                `说明:详情页入口字段「${detailLinkField}」将在回放时于列表页生效(取该字段的 href 进详情页),` +
                    '本次仅在当前详情页校验详情字段,不校验列表页选择器。'
            );
        }
        if (passed) {
            aiStatusEl.classList.add('ok');
            aiStatusEl.textContent = `已生成并实测通过(${lastLabel}),规则已填入上方。`;
            logLocal(`AI 提取成功且选择器实测通过(${lastLabel}),规则已填入「提取规则」,可直接点「运行宏」。`);
        } else {
            aiStatusEl.classList.add('err');
            aiStatusEl.textContent = '已生成但选择器实测未全部命中,已填入上方,请人工核对。';
            logLocal(
                `选择器实测在 ${maxAttempts} 次内仍未全部命中,已填入最后一版规则,请人工核对选择器(末轮实测:${summarizeChecks(lastChecks)})`,
                'error'
            );
        }
    } catch (e) {
        aiStatusEl.classList.add('err');
        aiStatusEl.textContent = '生成异常,详见日志。';
        logLocal('AI 提取调用异常:' + (e as Error).message, 'error');
    } finally {
        setAiBusy(false);
    }
});

// 上传 ai-config.json:主进程弹文件框 + 校验,通过则覆盖生效并刷新下拉
aiImportBtn.addEventListener('click', async () => {
    aiImportBtn.disabled = true;
    try {
        const res = await window.electronAPI.importAiConfig();
        if (res.canceled) {
            return; // 用户取消,静默
        }
        if (res.ok) {
            await loadAiProfiles();
            aiStatusEl.classList.remove('err');
            aiStatusEl.classList.add('ok');
            aiStatusEl.textContent = `配置已更新(共 ${res.profileCount} 个配置档)。`;
            logLocal(`AI 配置已更新并生效,共 ${res.profileCount} 个配置档。`);
        } else {
            aiStatusEl.classList.remove('ok');
            aiStatusEl.classList.add('err');
            aiStatusEl.textContent = '上传配置校验失败,详见日志。';
            logLocal('上传的 ai-config.json 校验失败:' + (res.error ?? '未知错误'), 'error');
        }
    } catch (e) {
        logLocal('上传 ai-config.json 异常:' + (e as Error).message, 'error');
    } finally {
        aiImportBtn.disabled = false;
    }
});

// ===== webview 事件 =====
webview.addEventListener('dom-ready', () => {
    const url = safeGetUrl();
    if (url) {
        addressInput.value = url;
    }
    if (recording) {
        armRecorder(true); // 导航后重新武装录制器
    }
    // 拾取期间发生导航:preload 随旧文档销毁,picker 状态已失效,丢弃悬挂的回调
    if (pendingPick) {
        pendingPick = null;
        logLocal('页面已跳转,元素拾取已取消。');
    }
});

// 接收来自录制 preload 的步骤
// 注:dom-ready / ipc-message / did-navigate 为 webview 专有事件,DOM 类型未涵盖,故用 any。
webview.addEventListener('ipc-message', (e: any) => {
    if (e.channel === 'macro-step') {
        const step = e.args[0] as Step;
        if (step && typeof step.type === 'string') {
            addStep(step);
        }
    } else if (e.channel === 'picker-result') {
        const r = e.args[0] as { selector?: string; fingerprint?: unknown; cancelled?: boolean } | undefined;
        const handler = pendingPick;
        pendingPick = null;
        // 恢复拾取前临时挂起的录制
        if (recording) {
            armRecorder(true);
        }
        if (!r || r.cancelled) {
            logLocal('已取消元素拾取。');
            return;
        }
        if (!r.selector) {
            logLocal('未能为所选元素生成选择器,请重试。', 'error');
            return;
        }
        // 把选择器交给本次拾取的发起方(用途由回调决定)
        if (handler) {
            handler(r.selector, r.fingerprint);
        }
    }
});

webview.addEventListener('did-navigate', (e: any) => {
    if (e.url) {
        addressInput.value = e.url;
    }
});

// ===== 左右宽度拖动 =====
const SIDEBAR_WIDTH_KEY = 'macro.sidebarWidth';
const SIDEBAR_MIN = 240; // 右栏最窄
const SIDEBAR_MAX_RATIO = 0.75; // 右栏最宽不超过 .main 宽度的 75%,保证浏览器可见

/** 把右栏宽度写到样式(同时设 flex-basis 与 width,覆盖 CSS 固定值) */
function applySidebarWidth(sidebar: HTMLElement, w: number): void {
    sidebar.style.flex = '0 0 ' + w + 'px';
    sidebar.style.width = w + 'px';
}

/** 初始化分隔条拖动:鼠标按下→移动→松开实时调整右栏宽度,松开后存 localStorage */
function setupMainDivider(): void {
    const divider = document.getElementById('main-divider');
    const main = document.querySelector<HTMLElement>('.main');
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    if (!divider || !main || !sidebar) return;

    // 启动时恢复上次宽度(合法才应用)
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= SIDEBAR_MIN) {
        const max = main.getBoundingClientRect().width * SIDEBAR_MAX_RATIO;
        applySidebarWidth(sidebar, Math.min(saved, max || saved));
    }

    const onMove = (e: MouseEvent): void => {
        const rect = main.getBoundingClientRect();
        const max = rect.width * SIDEBAR_MAX_RATIO;
        let w = rect.right - e.clientX;
        w = Math.max(SIDEBAR_MIN, Math.min(w, max));
        applySidebarWidth(sidebar, w);
    };
    const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        main.classList.remove('resizing');
        divider.classList.remove('dragging');
        // 保存当前实际宽度
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(sidebar.getBoundingClientRect().width)));
    };
    divider.addEventListener('mousedown', (e) => {
        e.preventDefault();
        main.classList.add('resizing');
        divider.classList.add('dragging');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// ===== 初始化 =====
/** 隐藏启动加载遮罩(淡出后移除,失败也不影响界面) */
function hideBootOverlay(): void {
    const overlay = document.getElementById('boot-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    // 等淡出过渡结束后彻底移除,避免残留遮罩拦截点击
    setTimeout(() => overlay.remove(), 300);
}

async function init(): Promise<void> {
    extractInput.value = DEFAULT_EXTRACT;
    refreshAiModeOptions();
    addressInput.value = 'https://books.toscrape.com/';
    setRecordingUI(false);
    setupMainDivider();
    window.electronAPI.onLog((msg) => appendLog(msg.message, msg.level, msg.time));
    window.electronAPI.onMacroPaused((info) => showPauseModal(info));
    // 等关键配置加载完成再隐藏遮罩;任一失败也继续(保证遮罩一定会消失)
    await Promise.allSettled([loadAiProfiles(), loadBrowserConfig(), loadPlugins()]);
    logLocal('就绪。输入网址后点击「打开网页」,再「开始录制」。');
    hideBootOverlay();
}

void init();
