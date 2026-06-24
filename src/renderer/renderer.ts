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

interface RunResult {
    ok: boolean;
    rows?: Record<string, string>[];
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
    elapsedMs: number;
}

interface ElectronAPI {
    getWebviewPreloadPath(): Promise<string>;
    saveMacro(macro: Macro): Promise<string | null>;
    loadMacro(): Promise<Macro | null>;
    runMacro(macro: Macro): Promise<RunResult>;
    exportExcel(rows: Record<string, string>[]): Promise<string>;
    onLog(cb: (msg: LogMessage) => void): void;
    aiListProfiles(): Promise<AiProfilesInfo>;
    aiGenerateExtract(input: {
        requirement: string;
        html: string;
        profileId?: string;
        mode?: 'single' | 'list' | 'list-detail';
        baseRules?: unknown;
    }): Promise<AiGenerateResult>;
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
const exportBtn = byId<HTMLButtonElement>('export');
const aiProfileSel = byId<HTMLSelectElement>('ai-profile');
const aiModeSel = byId<HTMLSelectElement>('ai-mode');
const aiRequirementInput = byId<HTMLTextAreaElement>('ai-requirement');
const aiGenerateBtn = byId<HTMLButtonElement>('ai-generate');
const aiStatusEl = byId<HTMLSpanElement>('ai-status');

// ===== 状态 =====
let recording = false;
let steps: Step[] = [];
let lastRows: Record<string, string>[] = [];

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
        case 'waitForSelector':
            return `waitForSelector ${s.selector}`;
        default:
            return step.type;
    }
}

function renderSteps(): void {
    stepsEl.innerHTML = '';
    steps.forEach((step, i) => {
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
        // 右键弹出操作菜单
        div.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showStepContextMenu(e.clientX, e.clientY, i);
        });
        stepsEl.appendChild(div);
    });
    stepCountEl.textContent = String(steps.length);
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

    if (step.pagination === true) {
        // 已标记:提供「修改总页数」与「取消翻页标记」
        const current = typeof step.pageCount === 'number' ? step.pageCount : 1;
        const editItem = makeMenuItem(`修改翻页总页数(当前 ${current})`, () => {
            showPageCountInput(menu, index);
        });
        const unmarkItem = makeMenuItem('取消翻页标记', () => {
            delete steps[index].pagination;
            delete steps[index].pageCount;
            closeStepContextMenu();
            renderSteps();
            logLocal(`步骤 #${index + 1} 已取消翻页标记。`);
        });
        menu.appendChild(editItem);
        menu.appendChild(unmarkItem);
    } else {
        const markItem = makeMenuItem('标记翻页操作', () => {
            showPageCountInput(menu, index);
        });
        menu.appendChild(markItem);
    }

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

function makeMenuItem(label: string, onClick: () => void): HTMLDivElement {
    const item = document.createElement('div');
    item.className = 'ctx-menu-item';
    item.textContent = label;
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
    return macro;
}

/** 解析「提取规则」框,返回合法的 mode=list 规则对象;不合法返回 null(供 list-detail 取基础规则) */
function parseValidListRules(): Record<string, unknown> | null {
    const raw = extractInput.value.trim();
    if (!raw) {
        return null;
    }
    try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (
            obj &&
            obj.mode === 'list' &&
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
}

// 用户手动编辑「提取规则」框时,实时联动 list-detail 选项可用性
extractInput.addEventListener('input', refreshAiModeOptions);

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
    steps = [];
    renderSteps();
    const url = safeGetUrl();
    if (url && url !== 'about:blank') {
        addStep({ type: 'goto', url });
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
        if (result.ok) {
            lastRows = result.rows ?? [];
            logLocal(`运行成功,提取到 ${lastRows.length} 行数据。可点击「导出 Excel」。`);
        } else {
            const err = result.error;
            logLocal(
                `运行失败:第 ${(err?.stepIndex ?? -1) + 1} 步(${err?.stepType})` +
                    `${err?.selector ? ' selector=' + err.selector : ''}` +
                    ` URL=${err?.url ?? '未知'} 原因:${err?.message}`,
                'error'
            );
        }
    } catch (e) {
        logLocal('运行宏异常:' + (e as Error).message, 'error');
    } finally {
        setBusy(false);
    }
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
        refreshAiModeOptions();
    }
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
    const mode = aiModeSel.value as 'single' | 'list' | 'list-detail';

    // list-detail 必须以现有合法 list 规则为基础;生成时兜底校验
    let baseRules: Record<string, unknown> | undefined;
    if (mode === 'list-detail') {
        const base = parseValidListRules();
        if (!base) {
            logLocal('「列表+详情」模式需要先在「提取规则」框中填入合法的 mode=list 规则(含 listSelector 与 fields),生成已取消。', 'error');
            return;
        }
        baseRules = base;
    }

    aiStatusEl.classList.remove('ok', 'err');
    setAiBusy(true);
    aiStatusEl.textContent = '正在请求 AI,请稍候……';
    logLocal(`AI 提取:已抓取页面 HTML(${html.length} 字符),目标模式「${mode}」,提交「${profileId ?? '默认'}」生成规则……`);
    try {
        const res = await window.electronAPI.aiGenerateExtract({ requirement, html, profileId, mode, baseRules });
        if (res.ok && res.rules) {
            extractInput.value = JSON.stringify(res.rules, null, 4);
            refreshAiModeOptions();
            aiStatusEl.classList.add('ok');
            aiStatusEl.textContent = `已生成(${res.profileLabel},${res.elapsedMs}ms),规则已填入上方。`;
            logLocal(`AI 提取成功(${res.profileLabel}),规则已填入「提取规则」,可直接点「运行宏」。`);
        } else {
            aiStatusEl.classList.add('err');
            aiStatusEl.textContent = '生成失败,详见日志。';
            logLocal(`AI 提取失败:${res.error ?? '未知错误'}`, 'error');
            if (res.raw) {
                logLocal('模型原始回复:' + res.raw.slice(0, 500), 'error');
            }
        }
    } catch (e) {
        aiStatusEl.classList.add('err');
        aiStatusEl.textContent = '生成异常,详见日志。';
        logLocal('AI 提取调用异常:' + (e as Error).message, 'error');
    } finally {
        setAiBusy(false);
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
});

// 接收来自录制 preload 的步骤
// 注:dom-ready / ipc-message / did-navigate 为 webview 专有事件,DOM 类型未涵盖,故用 any。
webview.addEventListener('ipc-message', (e: any) => {
    if (e.channel === 'macro-step') {
        const step = e.args[0] as Step;
        if (step && typeof step.type === 'string') {
            addStep(step);
        }
    }
});

webview.addEventListener('did-navigate', (e: any) => {
    if (e.url) {
        addressInput.value = e.url;
    }
});

// ===== 初始化 =====
function init(): void {
    extractInput.value = DEFAULT_EXTRACT;
    refreshAiModeOptions();
    addressInput.value = 'https://books.toscrape.com/';
    setRecordingUI(false);
    window.electronAPI.onLog((msg) => appendLog(msg.message, msg.level, msg.time));
    void loadAiProfiles();
    logLocal('就绪。输入网址后点击「打开网页」,再「开始录制」。');
}

init();
