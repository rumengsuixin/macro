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
    /** true=独立工具(渲染到独立工具板块、无复选框);缺省=随宏勾选的后处理器 */
    standalone?: boolean;
}

interface RunResult {
    ok: boolean;
    rows?: Record<string, string>[];
    downloads?: string[];
    postProcessed?: PostProcessResult[];
    /** 用户中途点「停止回放」主动中止(非失败) */
    cancelled?: boolean;
    error?: RunError;
    /** 回放记录的每步真实页面 URL(与 steps 同序,取不到为 null);供旧宏回填 recordedUrl */
    stepUrls?: (string | null)[];
}

/** 宏库列表项摘要(与主进程 MacroSummary 对应) */
interface MacroSummary {
    filePath: string;
    name: string;
    stepCount: number;
    modifiedMs: number;
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

/** 元素录制时的 DOM 上下文(离线 AI 校正用),与 core 的 StepCapture 对应 */
interface StepCapture {
    outerHTML: string;
    ancestors: string;
    contextHtml: string;
}
/** 宏旁车结构(与宏 steps 同序对齐) */
interface MacroCaptures {
    version: number;
    steps: ({ type: string; selector: string; capture: StepCapture } | null)[];
}

interface ElectronAPI {
    getWebviewPreloadPath(): Promise<string>;
    saveMacro(macro: Macro, captures?: MacroCaptures | null): Promise<string | null>;
    loadMacro(): Promise<{ macro: Macro; captures: MacroCaptures | null; filePath: string } | null>;
    persistMacro(macro: Macro, captures: MacroCaptures | null, filePath: string): Promise<string | null>;
    listMacros(): Promise<MacroSummary[]>;
    readMacro(filePath: string): Promise<{ macro: Macro; captures: MacroCaptures | null; filePath: string } | null>;
    openMacrosDir(): Promise<string>;
    runMacro(macro: Macro): Promise<RunResult>;
    exportExcel(rows: Record<string, string>[]): Promise<string>;
    listPlugins(): Promise<PostProcessorManifest[]>;
    runPlugin(type: string): Promise<{ canceled?: boolean; results?: PostProcessResult[] }>;
    onLog(cb: (msg: LogMessage) => void): void;
    onMacroPaused(cb: (info: PauseEvent) => void): void;
    resumeMacro(runId: number): void;
    onMacroRunStarted(cb: (info: { runId: number }) => void): void;
    stopMacro(runId: number): void;
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
    aiFixSelector(input: {
        profileId?: string;
        current: string;
        reason?: string;
        elementHtml: string;
        ancestors?: string;
        feedback?: string;
        sessionKey?: string;
    }): Promise<{
        ok: boolean;
        selector?: string;
        error?: string;
        sessionKey?: string;
        profileLabel: string;
        elapsedMs: number;
    }>;
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
const stopRunBtn = byId<HTMLButtonElement>('stop-run');
const saveBtn = byId<HTMLButtonElement>('save');
const loadBtn = byId<HTMLButtonElement>('load');
const exportBtn = byId<HTMLButtonElement>('export');
const aiFixAllBtn = byId<HTMLButtonElement>('ai-fix-all');
const autosaveToggle = byId<HTMLInputElement>('autosave-toggle');
const pauseOverlay = byId<HTMLDivElement>('pause-overlay');
const pauseReasonEl = byId<HTMLDivElement>('pause-reason');
const pauseContinueBtn = byId<HTMLButtonElement>('pause-continue');
const pauseStopBtn = byId<HTMLButtonElement>('pause-stop');
const confirmOverlay = byId<HTMLDivElement>('confirm-overlay');
const confirmTitleEl = byId<HTMLHeadingElement>('confirm-title');
const confirmMessageEl = byId<HTMLDivElement>('confirm-message');
const confirmOkBtn = byId<HTMLButtonElement>('confirm-ok');
const confirmCancelBtn = byId<HTMLButtonElement>('confirm-cancel');
const aiProfileSel = byId<HTMLSelectElement>('ai-profile');
const aiModeSel = byId<HTMLSelectElement>('ai-mode');
const aiRequirementInput = byId<HTMLTextAreaElement>('ai-requirement');
const aiGenerateBtn = byId<HTMLButtonElement>('ai-generate');
const aiImportBtn = byId<HTMLButtonElement>('ai-import');
const aiStatusEl = byId<HTMLSpanElement>('ai-status');
const aiDetailLinkRow = byId<HTMLDivElement>('ai-detail-link-row');
const aiDetailLinkFieldSel = byId<HTMLSelectElement>('ai-detail-link-field');
const appEl = document.querySelector('.app') as HTMLDivElement;
const pickHint = byId<HTMLDivElement>('pick-hint');
const pickCancelBtn = byId<HTMLButtonElement>('pick-cancel');

// ===== 状态 =====
let recording = false;
let steps: Step[] = [];
let lastRows: Record<string, string>[] = [];
// 当前宏文件路径(加载 / 首次手动保存后记住):实时自动保存(宏 + 旁车)写回此文件;null 表示尚无路径(新录未存),不自动保存
let currentMacroPath: string | null = null;
// 上次已落盘内容的签名:自动保存前比对,内容未变则跳过写盘(避免无意义 IO / 非改动型渲染触发写盘)
let lastPersistedSig = '';
// 元素拾取(通用「取选择器+回调」服务):pendingPick 保存当前这次拾取的消费回调,
// null 表示无进行中的拾取。用途由发起方通过回调决定(本文件 fingerprint 暂不消费,故用 unknown)。
type PickedHandler = (selector: string, fingerprint?: unknown, context?: unknown) => void;
let pendingPick: PickedHandler | null = null;
// 已展开的连续滚动组——按「组首 step 对象引用」记录;默认折叠(不在集合里即折叠)。
// 用对象引用而非下标:step 对象在 splice/push 中保持身份不变,插入/删除/拖拽后仍能命中;
// 加载新宏时整个 steps 数组被替换为新对象,旧记录自动被 GC。
const expandedScrollGroups = new WeakSet<Step>();

// 步骤按「录制来源 URL」分组显示相关状态:
// - stepUrls:每次 renderSteps() 刷新,与 steps 同序对齐,拖拽"同组"判定复用它;
// - collapsedUrlGroups:已折叠的 URL 组(按 URL 字符串记忆,默认展开=不在集合里);加载新宏时清空。
let stepUrls: string[] = [];
const collapsedUrlGroups = new Set<string>();

// ===== 步骤元素上下文(离线 AI 校正选择器)=====
// 录制时抓的 {outerHTML,ancestors,contextHtml} 存这里,按步骤内存字段 `cid` 关联。
// 用 cid+Map(而非 WeakSet/WeakMap 按对象身份):undo/redo 走 JSON.parse 会重建 step 对象,
// 但 cid 是普通字段随之保留,Map 独立于快照,故撤销后仍能查到上下文。cid 保存时从宏 JSON 剥离。
const stepCaptures = new Map<string, StepCapture>();

/** 生成一个内存用的短唯一 id(优先 crypto.randomUUID,不可用时回退) */
function genCid(): string {
    try {
        return crypto.randomUUID();
    } catch {
        return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
}

/** 给某步挂上下文:复用已有 cid(如重新点选刷新),否则分配新 cid;空上下文忽略 */
function attachCapture(step: Step, context: unknown): void {
    const cap = context as StepCapture | undefined;
    if (!cap || !cap.outerHTML) {
        return;
    }
    let cid = typeof step.cid === 'string' ? step.cid : undefined;
    if (!cid) {
        cid = genCid();
        step.cid = cid;
    }
    stepCaptures.set(cid, cap);
}

/** 取某步的录制上下文(无则 undefined) */
function captureOf(step: Step): StepCapture | undefined {
    const cid = typeof step.cid === 'string' ? step.cid : undefined;
    return cid ? stepCaptures.get(cid) : undefined;
}

// ===== 步骤撤销/重做(通用快照机制)=====
// 不给每种操作写逆操作,而是在 renderSteps() 顶部自动 diff `steps` 的 JSON:
// 所有改动 steps 的代码都紧跟一次 renderSteps(),非改动型渲染(展开/折叠)不改内容不入栈。
// 天然覆盖一切(现有与未来)步骤操作。会话内内存栈,不持久化。
let undoStack: string[] = []; // 历史快照(JSON 串,存「变更前」状态)
let redoStack: string[] = [];
let lastStepsJson = '[]'; // 上次渲染时 steps 的 JSON
let applyingHistory = false; // 撤销/重做过程中,不再记账
const UNDO_LIMIT = 100;

/** 在 renderSteps() 最顶部调用:侦测 steps 是否变化,变了就把「上一态」压入撤销栈 */
function captureHistoryOnRender(): void {
    if (applyingHistory) {
        return;
    }
    const cur = JSON.stringify(steps);
    if (cur !== lastStepsJson) {
        undoStack.push(lastStepsJson);
        if (undoStack.length > UNDO_LIMIT) {
            undoStack.shift();
        }
        redoStack = []; // 出现新改动 → redo 失效
        lastStepsJson = cur;
    }
}

/** 撤销:恢复上一份 steps 快照 */
function undoSteps(): void {
    if (!undoStack.length) {
        logLocal('没有可撤销的步骤操作。');
        return;
    }
    redoStack.push(lastStepsJson);
    const prev = undoStack.pop() as string;
    applyingHistory = true;
    steps = JSON.parse(prev) as Step[];
    lastStepsJson = prev;
    renderSteps();
    applyingHistory = false;
    logLocal('已撤销上一步步骤改动。');
}

/** 重做:恢复被撤销掉的 steps 快照 */
function redoSteps(): void {
    if (!redoStack.length) {
        logLocal('没有可重做的步骤操作。');
        return;
    }
    undoStack.push(lastStepsJson);
    const next = redoStack.pop() as string;
    applyingHistory = true;
    steps = JSON.parse(next) as Step[];
    lastStepsJson = next;
    renderSteps();
    applyingHistory = false;
    logLocal('已重做步骤改动。');
}

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

// ===== 步骤展示(面向普通用户的「人话」文案) =====
// 步骤行不再直接暴露 CSS/xpath 选择器,而是用录制时已存进 step 的语义指纹
// (fingerprint.text/ariaLabel/tag)+ 值/网址 生成中文短语;原始选择器降级到
// 步骤行的 title 悬停 + 高级模式下的灰字 span(见 createStepLine)。

/** 取步骤的语义指纹对象(松散 Step 上的可选字段),无则 undefined */
function stepFingerprint(step: Step): Record<string, unknown> | undefined {
    const fp = (step as Record<string, unknown>).fingerprint;
    return fp && typeof fp === 'object' ? (fp as Record<string, unknown>) : undefined;
}

/** 元素类别中文(用于人话文案:点击「登录」按钮 / 点击一个链接) */
function elementKind(tag?: string): string {
    switch ((tag || '').toLowerCase()) {
        case 'a':
            return '链接';
        case 'button':
            return '按钮';
        case 'input':
        case 'textarea':
        case 'select':
            return '输入框';
        default:
            return '元素';
    }
}

/**
 * 从语义指纹拼出元素的人话标签:
 * 有可见文字/aria-label → 「下一页」链接 / 「登录」按钮;都没有 → 一个链接 / 一个元素(旧宏兜底)
 */
function elementLabel(fp: Record<string, unknown> | undefined): string {
    const tag = fp && typeof fp.tag === 'string' ? fp.tag : undefined;
    const kind = elementKind(tag);
    const text = fp && typeof fp.text === 'string' ? fp.text.trim() : '';
    const aria = fp && typeof fp.ariaLabel === 'string' ? fp.ariaLabel.trim() : '';
    const label = text || aria;
    if (label) {
        const short = label.length > 24 ? label.slice(0, 24) + '…' : label;
        // 元素类别未知时不缀"元素"避免啰嗦
        return kind === '元素' ? `「${short}」` : `「${short}」${kind}`;
    }
    return `一个${kind}`;
}

/** 常用按键中文化(其余原样) */
function friendlyKey(key: string): string {
    const map: Record<string, string> = {
        Enter: '回车',
        Escape: 'Esc',
        Tab: 'Tab',
        Backspace: '退格',
        Delete: '删除',
        ArrowUp: '↑',
        ArrowDown: '↓',
        ArrowLeft: '←',
        ArrowRight: '→',
        ' ': '空格',
    };
    return map[key] || key;
}

/** 步骤类型图标(便于一眼扫读区分步骤类别) */
function stepIcon(step: Step): string {
    switch (step.type) {
        case 'goto':
            return '🌐';
        case 'click':
            return '🖱️';
        case 'fill':
        case 'press':
            return '⌨️';
        case 'waitForSelector':
        case 'waitForClickable':
        case 'wait-for-load':
            return '⏳';
        case 'pause':
            return '⏸️';
        case 'scroll-bottom':
            return '⬇️';
        case 'scroll':
            return '↕️';
        default:
            return '•';
    }
}

/** 步骤人话文案(不含原始选择器);用语义指纹 / 值 / 网址生成 */
function describeStep(step: Step): string {
    const s = step as Record<string, unknown>;
    const fp = stepFingerprint(step);
    switch (step.type) {
        case 'goto':
            return `打开网页 ${friendlyUrl(typeof s.url === 'string' ? s.url : '')}`;
        case 'click':
            return `点击${elementLabel(fp)}`;
        case 'fill': {
            const val = typeof s.value === 'string' ? s.value : '';
            const aria = fp && typeof fp.ariaLabel === 'string' ? fp.ariaLabel.trim() : '';
            return aria ? `在「${aria}」框输入「${val}」` : `输入「${val}」`;
        }
        case 'press':
            return `按下 ${friendlyKey(typeof s.key === 'string' ? s.key : '')} 键`;
        case 'scroll':
            return '滚动页面';
        case 'scroll-bottom':
            return '滚动到页面底部';
        case 'wait-for-load':
            return '等待页面加载完成';
        case 'waitForSelector':
            return `等待${elementLabel(fp)}出现`;
        case 'waitForClickable':
            return `等待${elementLabel(fp)}可以点击`;
        case 'pause':
            return `暂停,等待人工操作${typeof s.reason === 'string' && s.reason ? ':' + s.reason : ''}`;
        default:
            return step.type;
    }
}

/** 步骤的原始定位串(选择器;goto 为完整网址)——仅用于高级模式灰字 span,无则空串 */
function stepSelector(step: Step): string {
    const s = step as Record<string, unknown>;
    if (step.type === 'goto') {
        return typeof s.url === 'string' ? s.url : '';
    }
    return typeof s.selector === 'string' ? s.selector : '';
}

/** 步骤原始技术详情(供步骤行 title 悬停排错);无 selector/url 的步骤返回空串 */
function stepRawDetail(step: Step): string {
    const s = step as Record<string, unknown>;
    const sel = typeof s.selector === 'string' ? s.selector : '';
    switch (step.type) {
        case 'goto':
            return typeof s.url === 'string' ? `goto ${s.url}` : '';
        case 'click':
            return sel ? `click ${sel}` : '';
        case 'fill':
            return sel ? `fill ${sel} = "${typeof s.value === 'string' ? s.value : ''}"` : '';
        case 'press':
            return sel ? `press ${typeof s.key === 'string' ? s.key : ''} @ ${sel}` : '';
        case 'waitForSelector':
            return sel ? `waitForSelector ${sel}` : '';
        case 'waitForClickable':
            return sel ? `waitForClickable ${sel}` : '';
        default:
            return '';
    }
}

/** 难懂步骤类型的一句话解释(ⓘ 悬停说明);其余类型返回空串 */
function stepHelp(step: Step): string {
    switch (step.type) {
        case 'waitForSelector':
            return '回放到这一步会先等这个元素在页面上出现,再继续下一步——用于等页面数据/内容加载好。';
        case 'waitForClickable':
            return '回放到这一步会等这个元素真正可以点击(不再被遮挡或禁用)再继续,比「等待出现」更严格。';
        case 'wait-for-load':
            return '等整个网页(含图片等资源)全部加载完成后再继续下一步。';
        case 'scroll-bottom':
            return '自动把页面滚到最底部,触发「下拉加载更多」式的内容加载。';
        case 'pause':
            return '回放到这一步会停下来,把浏览器交给你手动操作(如登录/验证码),完成后点「继续」。';
        default:
            return '';
    }
}

/** 创建单个步骤行 div(含文本、徽标、右键菜单、拖拽排序),事件均绑定真实下标 i */
function createStepLine(step: Step, i: number): HTMLDivElement {
    const div = document.createElement('div');
    div.className = 'step-line';
    // 序号 + 图标 + 人话文案 + (难懂类型)ⓘ 说明 + (有选择器时)灰字原始选择器。
    // 拆成子元素而非单一 textContent,以便分别控制样式与显隐;原始选择器降级到 title 悬停 + 高级模式灰字。
    const detail = stepRawDetail(step);
    if (detail) {
        div.title = detail; // 悬停显示原始选择器/网址,供排错
    }
    const indexSpan = document.createElement('span');
    indexSpan.className = 'step-index';
    indexSpan.textContent = `${i + 1}.`;
    div.appendChild(indexSpan);
    const iconSpan = document.createElement('span');
    iconSpan.className = 'step-icon';
    iconSpan.textContent = stepIcon(step);
    div.appendChild(iconSpan);
    const textSpan = document.createElement('span');
    textSpan.className = 'step-text';
    textSpan.textContent = describeStep(step);
    div.appendChild(textSpan);
    const help = stepHelp(step);
    if (help) {
        const helpSpan = document.createElement('span');
        helpSpan.className = 'step-help';
        helpSpan.textContent = 'ⓘ';
        helpSpan.title = help; // 一句话解释这步在做什么
        div.appendChild(helpSpan);
    }
    const sel = stepSelector(step);
    if (sel) {
        const selSpan = document.createElement('span');
        selSpan.className = 'step-selector'; // 默认隐藏,勾选「✨ 高级」后 CSS 显出灰字
        selSpan.textContent = sel;
        div.appendChild(selSpan);
    }
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
        // 跨 URL 组不允许落下:鼠标显示禁止、不画指示线
        if (dragFromIndex !== null && stepUrls[dragFromIndex] !== stepUrls[i]) {
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = 'none';
            }
            return;
        }
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
        // 跨 URL 组落下:拒绝(只能在本组内重排,不能出界)
        if (stepUrls[dragFromIndex] !== stepUrls[i]) {
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

/**
 * 派生每个步骤的"录制来源 URL"(与 steps 同序)。
 * goto 的 url 与其它步骤的 recordedUrl 都更新"当前 URL",其余步骤(手动插入 / 旧宏无戳)向前继承;
 * 空串代表未知来源。旧宏只有 goto 更新,退化为"按 goto 边界分组"。
 */
function computeStepUrls(): string[] {
    const out: string[] = [];
    let cur = '';
    for (const s of steps) {
        if (s.type === 'goto' && typeof (s as { url?: string }).url === 'string') {
            cur = (s as { url?: string }).url ?? cur;
        } else if (typeof s.recordedUrl === 'string' && s.recordedUrl) {
            cur = s.recordedUrl;
        }
        out.push(cur);
    }
    return out;
}

/** URL → 分组标题友好显示:域名+路径,过长截断;解析失败回退原串;空串回退占位 */
function friendlyUrl(u: string): string {
    if (!u) {
        return '(未记录来源)';
    }
    let s: string;
    try {
        const x = new URL(u);
        s = x.hostname + x.pathname;
    } catch {
        s = u;
    }
    return s.length > 48 ? s.slice(0, 48) + '…' : s;
}

/** 创建一个 URL 分组标题行(折叠箭头 + 友好网址 + N步 计数);点击折叠/展开该组 */
function createUrlGroupHead(url: string, count: number): HTMLDivElement {
    const head = document.createElement('div');
    head.className = 'url-group-head';
    const collapsed = collapsedUrlGroups.has(url);
    if (collapsed) {
        head.classList.add('collapsed');
    }
    const chevron = document.createElement('span');
    chevron.className = 'url-group-chevron';
    chevron.textContent = collapsed ? '▸' : '▾';
    const label = document.createElement('span');
    label.className = 'url-group-label';
    label.textContent = friendlyUrl(url);
    label.title = url || '(未记录来源)'; // 悬停显示完整 URL
    const cnt = document.createElement('span');
    cnt.className = 'url-group-count';
    cnt.textContent = `${count} 步`;
    head.appendChild(chevron);
    head.appendChild(label);
    head.appendChild(cnt);
    head.addEventListener('click', () => {
        if (collapsedUrlGroups.has(url)) {
            collapsedUrlGroups.delete(url);
        } else {
            collapsedUrlGroups.add(url);
        }
        renderSteps();
    });
    return head;
}

/** 把 [start,end) 区间的步骤渲染进 container(含连续滚动折叠);滚动折叠扫描不越出该区间 */
function renderStepRange(container: HTMLElement, start: number, end: number): void {
    let i = start;
    while (i < end) {
        const step = steps[i];
        // 连续滚动折叠:探测从 i 起的连续可分组滚动 [i, gEnd)(上限 end,不跨 URL 组)
        if (isGroupableScroll(step)) {
            let gEnd = i + 1;
            while (gEnd < end && isGroupableScroll(steps[gEnd])) {
                gEnd++;
            }
            const groupLen = gEnd - i;
            if (groupLen >= 2) {
                const expanded = expandedScrollGroups.has(step); // 以组首对象引用为锚
                const scHead = createStepLine(step, i);
                scHead.classList.add('scroll-group-head');
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
                scHead.appendChild(toggle);
                container.appendChild(scHead);
                // 展开态:逐条渲染后续滚动子项(缩进、淡色)
                if (expanded) {
                    for (let j = i + 1; j < gEnd; j++) {
                        const sub = createStepLine(steps[j], j);
                        sub.classList.add('scroll-group-item');
                        container.appendChild(sub);
                    }
                }
                i = gEnd;
                continue;
            }
        }
        // 普通步骤(含单条滚动):正常单行渲染
        container.appendChild(createStepLine(steps[i], i));
        i++;
    }
}

function renderSteps(): void {
    captureHistoryOnRender(); // 渲染前记账:steps 相对上次渲染若有变化则压入撤销栈
    stepsEl.innerHTML = '';
    stepUrls = computeStepUrls(); // 刷新拖拽"同组"判定所用的对齐 URL 表
    let i = 0;
    // 按连续同 URL 分块:每块一个 .url-group(标题 + body),body 内再做连续滚动折叠
    while (i < steps.length) {
        const url = stepUrls[i];
        let runEnd = i + 1;
        while (runEnd < steps.length && stepUrls[runEnd] === url) {
            runEnd++;
        }
        const group = document.createElement('div');
        group.className = 'url-group';
        group.appendChild(createUrlGroupHead(url, runEnd - i));
        if (collapsedUrlGroups.has(url)) {
            group.classList.add('collapsed');
        } else {
            const body = document.createElement('div');
            body.className = 'url-group-body';
            renderStepRange(body, i, runEnd);
            group.appendChild(body);
        }
        stepsEl.appendChild(group);
        i = runEnd;
    }
    stepCountEl.textContent = String(steps.length);
    // 统一自动保存切入点:任何改动 steps 的操作都紧跟一次 renderSteps();签名去重挡掉非改动型渲染
    scheduleAutosave();
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
        requestPick((selector, fingerprint, context) => insertWaitForSelector(at, selector, fingerprint, context));
    }));
    // 在此后添加「等待元素可点击」步骤(比「出现」更强:等到可交互;点选目标元素)
    menu.appendChild(makeMenuItem('🖱️', '在此后添加等待元素可点击(点选)', () => {
        const at = index + 1;
        closeStepContextMenu();
        requestPick((selector, fingerprint, context) => insertWaitForClickable(at, selector, fingerprint, context));
    }));
    // fill 步骤:就地修改要填写的文本内容(无需重录/改 JSON)
    if (step.type === 'fill') {
        menu.appendChild(makeMenuItem('✏️', '修改填写内容', () => {
            showFillValueInput(menu, index);
        }));
    }
    // 仅带选择器的步骤(click/fill/waitForSelector/带 selector 的 press)可「重新点选」修正
    if (typeof step.selector === 'string' && step.selector) {
        const target = step; // 捕获对象引用:拾取异步期间即使排序变化也能定位到正确步骤
        menu.appendChild(makeMenuItem('🎯', '重新点选此步骤的选择器', () => {
            closeStepContextMenu();
            requestPick((selector, fingerprint, context) => {
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
                // 刷新该步的录制上下文(重新点选的是新元素/新位置)
                attachCapture(target, context);
                renderSteps();
                logLocal(`步骤 #${i + 1} 的选择器已更新为:${selector}`);
            });
        }));
        // AI 校正此步骤选择器:让 AI 看真实 DOM 上下文重挑更稳定的选择器,实测唯一命中后落地
        const fixTarget = step;
        menu.appendChild(makeMenuItem('🤖', 'AI 校正此步骤选择器', () => {
            closeStepContextMenu();
            const i = steps.indexOf(fixTarget);
            if (i >= 0) {
                void fixStepSelector(i);
            }
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

/** 在菜单内显示 fill 步骤的填写内容输入框 */
function showFillValueInput(menu: HTMLDivElement, index: number): void {
    menu.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'ctx-menu-input';

    const label = document.createElement('div');
    label.className = 'ctx-menu-label';
    label.textContent = '填写内容:';

    const input = document.createElement('input');
    input.type = 'text';
    input.style.width = '180px';
    input.value = typeof steps[index].value === 'string' ? (steps[index].value as string) : '';

    const confirm = (): void => {
        steps[index].value = input.value; // 不 trim:保留用户输入原样;允许空串
        closeStepContextMenu();
        renderSteps();
        logLocal(`步骤 #${index + 1} 填写内容已更新。`);
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

// 进入拾取模式的主窗口 UI:焦点交给录制浏览器、屏蔽其余区域并变暗、显示提示横幅。
function enterPickingUI(): void {
    appEl.classList.add('picking');
    pickHint.classList.add('show');
    // 焦点交给内嵌浏览器(guest),使 ESC-in-guest 也即时可用,并把用户注意力引向浏览器
    try {
        webview.focus();
    } catch {
        // 忽略:焦点仅为体验优化,主窗口级 ESC 兜底仍有效
    }
}

// 退出拾取模式的主窗口 UI(与 enterPickingUI 成对,进入/退出各调一次)。
function exitPickingUI(): void {
    appEl.classList.remove('picking');
    pickHint.classList.remove('show');
}

// 取消进行中的拾取(主窗口有焦点时的 ESC / 横幅按钮路径)。
// 与 picker-result 分支均以 pendingPick 为闸门,幂等安全,不会重复处理。
function cancelPick(): void {
    if (!pendingPick) {
        return;
    }
    pendingPick = null;
    // 通知 preload 清理 guest 高亮/监听(exitPicker(false),不再回传 picker-result)
    try {
        webview.send('toggle-picker', false);
    } catch {
        // 页面已卸载等情况,忽略即可
    }
    if (recording) {
        armRecorder(true);
    }
    exitPickingUI();
    logLocal('已取消元素拾取。');
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
    enterPickingUI();
    logLocal('拾取模式已开启:请在页面中点击目标元素,按 ESC 取消。');
}

function insertWaitForSelector(at: number, selector: string, fingerprint?: unknown, context?: unknown): void {
    const clamped = Math.max(0, Math.min(at, steps.length));
    // 一并保存语义指纹:供「AI 校正选择器」在旧选择器失效时重定位元素
    const step: Step = { type: 'waitForSelector', selector, ...(fingerprint ? { fingerprint } : {}) };
    attachCapture(step, context); // 拾取时抓的 DOM 上下文,供离线校正
    steps.splice(clamped, 0, step);
    renderSteps();
    logLocal(`已在第 ${clamped + 1} 步位置添加「等待元素出现」:${selector}`);
}

function insertWaitForClickable(at: number, selector: string, fingerprint?: unknown, context?: unknown): void {
    const clamped = Math.max(0, Math.min(at, steps.length));
    const step: Step = { type: 'waitForClickable', selector, ...(fingerprint ? { fingerprint } : {}) };
    attachCapture(step, context);
    steps.splice(clamped, 0, step);
    renderSteps();
    logLocal(`已在第 ${clamped + 1} 步位置添加「等待元素可点击」:${selector}`);
}

function addStep(step: Step, context?: unknown): void {
    attachCapture(step, context); // 录制来的 click/fill 附带的元素上下文
    // 记录来源页面 URL(供步骤列表按 URL 分组);goto 自带 url 不重复打戳
    if (step.type !== 'goto' && !step.recordedUrl) {
        const u = safeGetUrl();
        if (u && u !== 'about:blank') {
            step.recordedUrl = u;
        }
    }
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
    aiFixAllBtn.disabled = on; // 录制中不批量校正(避免改动与录制交织)
    setMacroLibButtonsDisabled(on); // 录制中禁用宏库运行入口
}

function setBusy(busy: boolean): void {
    runBtn.disabled = busy;
    runBtn.textContent = busy ? '运行中…' : '运行宏';
    // 停止按钮与运行按钮相反:运行中可点、空闲禁用;每次切换复位其文案/禁用态
    stopRunBtn.disabled = !busy;
    stopRunBtn.textContent = '停止回放';
    aiFixAllBtn.disabled = busy; // 回放中不批量校正
    setMacroLibButtonsDisabled(busy); // 运行中禁用宏库运行入口,避免叠跑
}

// ===== 运行/停止:runId 与暂停模态框 =====
// 本次运行的 runId(主进程在运行开始时经 macro-run-started 推送),供「停止回放」回传
let activeRunId: number | null = null;
let currentPauseRunId: number | null = null;

// 「停止回放」按钮:向主进程发停止信号(runner.cancel() 会关浏览器打断当前操作)
stopRunBtn.addEventListener('click', () => {
    if (activeRunId === null) {
        return;
    }
    window.electronAPI.stopMacro(activeRunId);
    logLocal('已请求停止回放……');
    // 防重复点:禁用并改文案,待运行结束由 setBusy(false) 复位
    stopRunBtn.disabled = true;
    stopRunBtn.textContent = '停止中…';
});

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

/**
 * 通用确认模态框(风格同暂停模态框):填标题/正文并显示,返回 Promise<boolean>。
 * 点「确定」resolve(true),点「取消」/按 ESC resolve(false);仿暂停模态框不点击遮罩关闭。
 */
function confirmDialog(opts: {
    title: string;
    message: string;
    okText?: string;
    cancelText?: string;
}): Promise<boolean> {
    return new Promise((resolve) => {
        confirmTitleEl.textContent = opts.title;
        confirmMessageEl.textContent = opts.message;
        confirmOkBtn.textContent = opts.okText ?? '确定';
        confirmCancelBtn.textContent = opts.cancelText ?? '取消';

        const cleanup = (): void => {
            confirmOverlay.classList.remove('show');
            confirmOkBtn.removeEventListener('click', onOk);
            confirmCancelBtn.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey, true);
        };
        const onOk = (): void => {
            cleanup();
            resolve(true);
        };
        const onCancel = (): void => {
            cleanup();
            resolve(false);
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
            }
        };

        confirmOkBtn.addEventListener('click', onOk);
        confirmCancelBtn.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey, true);
        confirmOverlay.classList.add('show');
        confirmOkBtn.focus();
    });
}

pauseContinueBtn.addEventListener('click', () => {
    if (currentPauseRunId !== null) {
        window.electronAPI.resumeMacro(currentPauseRunId);
        logLocal('已点击「继续」,恢复回放。');
    }
    hidePauseModal();
});

// 暂停中「停止回放」:同时发 stop + resume——resume 让 handlePause 返回,
// 主循环下一轮顶部检查 cancelled 抛出干净退出(暂停期间无 Playwright 操作在跑,单靠关 context 不解除等待)
pauseStopBtn.addEventListener('click', () => {
    if (currentPauseRunId !== null) {
        window.electronAPI.stopMacro(currentPauseRunId);
        window.electronAPI.resumeMacro(currentPauseRunId);
        logLocal('已请求停止回放……');
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
/** 去掉仅内存字段(cid),保证宏 JSON 干净 */
function stripInternal(s: Step): Step {
    const { cid: _cid, ...rest } = s as Step & { cid?: string };
    return rest;
}

function buildMacro(): Macro {
    const name = nameInput.value.trim() || 'untitled-macro';
    // steps 剥掉内存字段 cid(元素上下文进旁车,不入宏 JSON)
    const macro: Macro = { name, version: 1, steps: steps.map(stripInternal) };
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

/** 组装与 steps 同序对齐的旁车上下文(供离线 AI 校正);无上下文的步骤为 null */
function buildCaptures(): MacroCaptures {
    return {
        version: 1,
        steps: steps.map((s) => {
            const cap = captureOf(s);
            const selector = typeof s.selector === 'string' ? s.selector : '';
            if (cap && selector) {
                return { type: s.type, selector, capture: cap };
            }
            return null;
        }),
    };
}

/** 加载宏后回挂旁车上下文:清空旧 Map,按同序 + type/selector 一致性校验给命中的步骤分配 cid */
function relinkCaptures(captures: MacroCaptures | null): void {
    stepCaptures.clear();
    if (!captures || !Array.isArray(captures.steps)) {
        return;
    }
    steps.forEach((s, i) => {
        const entry = captures.steps[i];
        if (entry && entry.capture && entry.type === s.type && entry.selector === s.selector) {
            const cid = genCid();
            s.cid = cid;
            stepCaptures.set(cid, entry.capture);
        }
    });
}

// ===== 实时自动保存(宏 + 旁车)=====
// 复用「所有步骤改动都紧跟 renderSteps()」这一统一切入点:renderSteps() 末尾调 scheduleAutosave(),
// debounce 后按签名去重落盘。宏 + 旁车一起写回当前文件(旁车靠下标+type+selector 与宏对齐,只存旁车会错位失效)。
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

/** 自动保存是否开启(复选框 + 有当前文件路径才生效) */
function autosaveEnabled(): boolean {
    return !!autosaveToggle && autosaveToggle.checked;
}

/** 当前宏 + 旁车的内容签名;提取规则 JSON 非法时 buildMacro 抛错,调用方需 try/catch */
function macroSignature(): string {
    return JSON.stringify([buildMacro(), buildCaptures()]);
}

/** 把「已落盘」基准更新为当前内容(load / 手动保存 / 打开开关后调用,避免随后无谓地再写一遍相同内容) */
function seedPersistedSig(): void {
    try {
        lastPersistedSig = macroSignature();
    } catch {
        lastPersistedSig = '';
    }
}

/** 立即执行一次自动保存(去重后写盘);内容未变或条件不满足则静默跳过 */
async function flushAutosave(): Promise<void> {
    if (!autosaveEnabled() || !currentMacroPath) {
        return;
    }
    let sig: string;
    let macro: Macro;
    let captures: MacroCaptures;
    try {
        macro = buildMacro();
        captures = buildCaptures();
        sig = JSON.stringify([macro, captures]);
    } catch {
        // 提取规则 JSON 非法等:自动保存静默跳过(手动保存会报该错),不刷屏
        return;
    }
    if (sig === lastPersistedSig) {
        return;
    }
    try {
        const saved = await window.electronAPI.persistMacro(macro, captures, currentMacroPath);
        if (saved) {
            lastPersistedSig = sig;
            logLocal(`已自动保存到:${saved}`);
        }
    } catch (e) {
        // 失败不更新 lastPersistedSig,下次改动会重试
        logLocal('自动保存失败:' + (e as Error).message, 'error');
    }
}

/** 安排一次防抖自动保存(合并连续改动为一次写盘) */
function scheduleAutosave(): void {
    if (!autosaveEnabled() || !currentMacroPath) {
        return;
    }
    if (autosaveTimer) {
        clearTimeout(autosaveTimer);
    }
    autosaveTimer = setTimeout(() => {
        autosaveTimer = null;
        void flushAutosave();
    }, 600);
}

// 自动保存开关:初值读 localStorage(默认开,同 HTML 的 checked);切换时存回,打开时立即落一次当前状态
const AUTOSAVE_LS_KEY = 'macro.autosave';
try {
    const savedPref = localStorage.getItem(AUTOSAVE_LS_KEY);
    if (savedPref !== null) {
        autosaveToggle.checked = savedPref === '1';
    }
} catch {
    // localStorage 不可用:沿用 HTML 默认 checked
}
autosaveToggle.addEventListener('change', () => {
    try {
        localStorage.setItem(AUTOSAVE_LS_KEY, autosaveToggle.checked ? '1' : '0');
    } catch {
        // 忽略存储失败
    }
    if (autosaveToggle.checked) {
        logLocal('已开启自动保存(改动步骤 / 选择器后自动写回当前文件)。');
        scheduleAutosave(); // 立即落一次当前状态
    } else {
        logLocal('已关闭自动保存(改动需手动点「保存宏」)。');
    }
});

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
const LIST_DETAIL_LABEL = '列表+点进详情页(list-detail)';

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
        : `${LIST_DETAIL_LABEL} — 需先配好上面的「采一个列表」`;
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
/**
 * 回放后回填步骤来源 URL:把回放引擎记录的每步真实页面 URL 写回缺失 recordedUrl 的步骤,
 * 让旧宏(录制时无来源 URL 戳)跑一次后即可精确按页面分组。只补缺失、不覆盖已有戳与 goto。
 */
function backfillRecordedUrls(urls?: (string | null)[]): void {
    if (!urls || urls.length !== steps.length) {
        return; // 长度不对齐(理论上不会,运行期禁编辑)则不冒险回填
    }
    let changed = 0;
    for (let i = 0; i < steps.length; i += 1) {
        const u = urls[i];
        const s = steps[i];
        if (!u || s.type === 'goto' || s.recordedUrl) {
            continue; // 无 URL / goto 自带 url / 已有戳(新宏)一律跳过
        }
        s.recordedUrl = u;
        changed += 1;
    }
    if (changed > 0) {
        logLocal(`已按回放实际页面回填 ${changed} 个步骤的来源 URL,分组更精确(改动已随自动保存落盘)。`);
        renderSteps(); // 刷新分组;末尾 scheduleAutosave() 自动把 recordedUrl 落盘
    }
}

function reportRunResult(result: RunResult, opts?: { fromEditor?: boolean }): void {
    const fromEditor = opts?.fromEditor !== false; // 默认视为编辑区自身的宏
    if (result.cancelled) {
        logLocal('回放已被用户停止。');
        return;
    }
    // 无论成功/失败,先把已记录的来源 URL 回填(失败前跑到的步骤也能受益)
    // 后台运行宏库里的别的宏(fromEditor=false)时跳过:回填只针对编辑区当前的宏,否则会污染编辑区
    if (fromEditor) {
        backfillRecordedUrls(result.stepUrls);
    }
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
        activeRunId = null; // 本次运行结束,清 runId
        hidePauseModal(); // 清理可能残留的暂停模态框(如超时失败返回时)
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
        // 随宏保存旁车上下文(离线 AI 校正用);宏本体不含 cid/DOM
        const captures = buildCaptures();
        const filePath = await window.electronAPI.saveMacro(macro, captures);
        if (filePath) {
            // 记住路径:此后改动可自动保存回此文件;种子签名避免紧接着再写一遍相同内容
            currentMacroPath = filePath;
            seedPersistedSig();
            logLocal(`宏已保存到:${filePath}`);
            void renderMacroLibrary(); // 新宏即时出现在宏库列表
        }
    } catch (e) {
        logLocal('保存宏失败:' + (e as Error).message, 'error');
    }
});

/** 把已读取的宏应用到编辑区(载入):回显名称/步骤/旁车/提取规则/插件,并追踪文件路径。
 *  供工具栏「加载宏」(弹框)与宏库面板「打开」(按路径)共用。 */
function applyLoadedMacro(loaded: { macro: Macro; captures: MacroCaptures | null; filePath: string }): void {
    const macro = loaded.macro;
    nameInput.value = macro.name ?? '';
    steps = Array.isArray(macro.steps) ? (macro.steps as Step[]) : [];
    collapsedUrlGroups.clear(); // 换宏重置 URL 分组折叠态(集合按 URL 字符串记忆,不随数组替换自动清)
    // 回挂旁车上下文:按同序对齐 + type/selector 一致性校验,给命中的步骤分配 cid 并入 Map
    relinkCaptures(loaded.captures);
    // 记住来源文件路径:此后改动步骤 / 选择器可自动保存回此文件(宏 + 旁车)
    currentMacroPath = loaded.filePath;
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
    // 种子签名(须在 extract / 插件回显完成后):置基准,防止加载后 renderSteps 排的那次 scheduleAutosave 写一遍相同内容
    seedPersistedSig();
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
}

loadBtn.addEventListener('click', async () => {
    let loaded: { macro: Macro; captures: MacroCaptures | null; filePath: string } | null = null;
    try {
        loaded = await window.electronAPI.loadMacro();
    } catch (e) {
        logLocal('加载宏失败:' + (e as Error).message, 'error');
        return;
    }
    if (!loaded) {
        return;
    }
    applyLoadedMacro(loaded);
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

// ===== 插件:可选插件列表(由后端注册表驱动) =====
// 两类分板块渲染:
//   · 后处理器(standalone 缺省 false)→ 附加处理板块「#plugin-list」:复选框(随主「运行」执行)+ 直接运行。
//   · 独立工具(standalone=true,如银行整合/对账)→ 独立工具板块「#tool-list」:只有「运行」按钮,无复选框
//     (输入是人工归集的文件、非宏回放产物,勾选随宏运行无意义)。
const pluginPanel = byId<HTMLDivElement>('plugin-panel');
const pluginTitle = byId<HTMLElement>('plugin-title');
const pluginList = byId<HTMLDivElement>('plugin-list');
const toolPanel = byId<HTMLDivElement>('tool-panel');
const toolTitle = byId<HTMLElement>('tool-title');
const toolList = byId<HTMLDivElement>('tool-list');

pluginTitle.addEventListener('click', () => {
    pluginPanel.classList.toggle('collapsed');
});
toolTitle.addEventListener('click', () => {
    toolPanel.classList.toggle('collapsed');
});

/**
 * 渲染一行插件到指定容器(行 + 其后兄弟描述节点)。
 * @param withCheckbox 为真=附加处理板块(复选框 + 直接运行);为假=独立工具板块(只有「运行」按钮)
 */
function renderPluginRow(
    container: HTMLElement,
    p: { type: string; label: string; description: string },
    withCheckbox: boolean
): void {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    if (withCheckbox) {
        // 附加处理:左侧勾选(随「运行」执行)+ 名称,右侧「直接运行」按钮
        const label = document.createElement('label');
        label.className = 'plugin-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.pluginType = p.type;
        const name = document.createElement('span');
        name.textContent = p.label;
        label.appendChild(cb);
        label.appendChild(name);
        row.appendChild(label);
    } else {
        // 独立工具:仅名称(无复选框),名称占满把按钮推到右侧
        const name = document.createElement('span');
        name.className = 'plugin-item';
        name.textContent = p.label;
        row.appendChild(name);
    }
    const runNow = document.createElement('button');
    runNow.className = 'plugin-run-now';
    runNow.textContent = withCheckbox ? '直接运行' : '运行';
    runNow.title = withCheckbox
        ? '不跑宏,直接选文件处理'
        : '选文件直接运行,产出整合/对账结果(与录制的宏无关)';
    runNow.addEventListener('click', () => void runPluginDirect(p.type, p.label));
    row.appendChild(runNow);
    const desc = document.createElement('div');
    desc.className = 'plugin-desc';
    desc.textContent = p.description;
    container.appendChild(row);
    container.appendChild(desc);
}

/** 从后端注册表拉取可用插件,按 standalone 分流渲染到「附加处理」与「独立工具」两个板块 */
async function loadPlugins(): Promise<void> {
    try {
        const plugins = await window.electronAPI.listPlugins();
        pluginList.innerHTML = '';
        toolList.innerHTML = '';
        const processors = plugins.filter((p) => !p.standalone);
        const tools = plugins.filter((p) => p.standalone);
        if (processors.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'hint';
            empty.textContent = '暂无可用插件。';
            pluginList.appendChild(empty);
        } else {
            for (const p of processors) {
                renderPluginRow(pluginList, p, true);
            }
        }
        if (tools.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'hint';
            empty.textContent = '暂无可用工具。';
            toolList.appendChild(empty);
        } else {
            for (const p of tools) {
                renderPluginRow(toolList, p, false);
            }
        }
    } catch (e) {
        logLocal('加载插件列表失败:' + (e as Error).message, 'error');
    }
}

/** 直接运行某插件/工具:弹文件选择(主进程),对所选文件直接处理,不跑宏 */
async function runPluginDirect(type: string, label: string): Promise<void> {
    setBusy(true);
    logLocal(`直接运行「${label}」:请选择要处理的文件(可多选 zip/csv/xls/xlsx/pdf)……`);
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

// ===== 宏库:批量列出 macros/ 目录、逐个/批量运行、一键载入 =====
const macroLibPanel = byId<HTMLDivElement>('macro-lib-panel');
const macroLibTitle = byId<HTMLElement>('macro-lib-title');
const macroLibList = byId<HTMLDivElement>('macro-lib-list');
const macroLibRefreshBtn = byId<HTMLButtonElement>('macro-lib-refresh');
const macroLibRunSelectedBtn = byId<HTMLButtonElement>('macro-lib-run-selected');
const macroLibOpenDirBtn = byId<HTMLButtonElement>('macro-lib-open-dir');

macroLibTitle.addEventListener('click', () => {
    macroLibPanel.classList.toggle('collapsed');
});

/** 扫描 macros/ 目录并渲染宏库列表(每项:勾选 + 名称/步数 + 打开 + 运行) */
async function renderMacroLibrary(): Promise<void> {
    let macros: MacroSummary[];
    try {
        macros = await window.electronAPI.listMacros();
    } catch (e) {
        logLocal('扫描宏库失败:' + (e as Error).message, 'error');
        return;
    }
    macroLibList.innerHTML = '';
    if (macros.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'hint';
        empty.textContent = '宏库为空。录制并「保存宏」后,会出现在这里。';
        macroLibList.appendChild(empty);
        return;
    }
    for (const m of macros) {
        const row = document.createElement('div');
        row.className = 'macro-item';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.filePath = m.filePath;
        cb.title = '勾选后可用「运行选中」批量顺序运行';

        const info = document.createElement('div');
        info.className = 'macro-item-info';
        const name = document.createElement('span');
        name.className = 'macro-item-name';
        name.textContent = m.name;
        name.title = m.filePath;
        const meta = document.createElement('span');
        meta.className = 'macro-item-meta';
        meta.textContent = `${m.stepCount} 步`;
        info.appendChild(name);
        info.appendChild(meta);

        const openBtn = document.createElement('button');
        openBtn.className = 'macro-item-open';
        openBtn.textContent = '打开';
        openBtn.title = '载入到左侧编辑区(可查看/修改步骤)';
        openBtn.addEventListener('click', () => void openMacroFromLibrary(m.filePath));

        const runBtn2 = document.createElement('button');
        runBtn2.className = 'macro-item-run';
        runBtn2.textContent = '运行';
        runBtn2.title = '后台直接运行此宏(不改动当前编辑区)';
        runBtn2.addEventListener('click', () => void runMacroFromLibrary(m));

        row.appendChild(cb);
        row.appendChild(info);
        row.appendChild(openBtn);
        row.appendChild(runBtn2);
        macroLibList.appendChild(row);
    }
    // 忙态下同步禁用列表内按钮(与主运行按钮一致)
    setMacroLibButtonsDisabled(runBtn.disabled || startBtn.disabled);
}

/** 统一切换宏库面板内所有按钮的禁用态(运行/录制忙时禁用,避免叠跑) */
function setMacroLibButtonsDisabled(disabled: boolean): void {
    macroLibRefreshBtn.disabled = disabled;
    macroLibRunSelectedBtn.disabled = disabled;
    macroLibList.querySelectorAll('button').forEach((b) => {
        (b as HTMLButtonElement).disabled = disabled;
    });
}

/** 宏库「打开」:按路径读取并载入编辑区(复用 applyLoadedMacro) */
async function openMacroFromLibrary(filePath: string): Promise<void> {
    let loaded: { macro: Macro; captures: MacroCaptures | null; filePath: string } | null = null;
    try {
        loaded = await window.electronAPI.readMacro(filePath);
    } catch (e) {
        logLocal('打开宏失败:' + (e as Error).message, 'error');
        return;
    }
    if (!loaded) {
        logLocal('打开宏失败:文件可能已被移动或损坏。请点🔄刷新。', 'error');
        return;
    }
    applyLoadedMacro(loaded);
}

/** 宏库「运行」:后台直接运行该宏,不改动编辑区(结果不回填编辑区步骤) */
async function runMacroFromLibrary(summary: MacroSummary): Promise<void> {
    let loaded: { macro: Macro; captures: MacroCaptures | null; filePath: string } | null = null;
    try {
        loaded = await window.electronAPI.readMacro(summary.filePath);
    } catch (e) {
        logLocal('读取宏失败:' + (e as Error).message, 'error');
        return;
    }
    if (!loaded) {
        logLocal('读取宏失败:文件可能已被移动或损坏。请点🔄刷新。', 'error');
        return;
    }
    if (!Array.isArray(loaded.macro.steps) || loaded.macro.steps.length === 0) {
        logLocal(`宏「${summary.name}」没有任何步骤,已跳过。`, 'error');
        return;
    }
    setBusy(true);
    setMacroLibButtonsDisabled(true);
    logLocal(`后台运行宏「${summary.name}」……(将弹出 Playwright 浏览器窗口,当前编辑区不受影响)`);
    try {
        const result = await window.electronAPI.runMacro(loaded.macro);
        reportRunResult(result, { fromEditor: false });
    } catch (e) {
        logLocal('运行宏异常:' + (e as Error).message, 'error');
    } finally {
        setBusy(false);
        setMacroLibButtonsDisabled(false);
        activeRunId = null;
        hidePauseModal();
    }
}

/** 宏库「运行选中」:按勾选顺序依次运行选中的多个宏,逐个汇报 + 末尾汇总 */
async function runSelectedMacros(): Promise<void> {
    const boxes = macroLibList.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-file-path]');
    const picked: string[] = [];
    boxes.forEach((cb) => {
        if (cb.checked && cb.dataset.filePath) {
            picked.push(cb.dataset.filePath);
        }
    });
    if (picked.length === 0) {
        logLocal('请先勾选要批量运行的宏。', 'error');
        return;
    }
    setBusy(true);
    setMacroLibButtonsDisabled(true);
    logLocal(`开始批量运行 ${picked.length} 个宏(依次顺序执行)……`);
    let okCount = 0;
    let failCount = 0;
    try {
        for (let k = 0; k < picked.length; k += 1) {
            const filePath = picked[k];
            let loaded: { macro: Macro; captures: MacroCaptures | null; filePath: string } | null = null;
            try {
                loaded = await window.electronAPI.readMacro(filePath);
            } catch (e) {
                loaded = null;
                logLocal(`[${k + 1}/${picked.length}] 读取失败:${(e as Error).message}`, 'error');
            }
            if (!loaded || !Array.isArray(loaded.macro.steps) || loaded.macro.steps.length === 0) {
                if (loaded) {
                    logLocal(`[${k + 1}/${picked.length}] 宏「${loaded.macro.name}」无步骤,已跳过。`, 'error');
                }
                failCount += 1;
                continue;
            }
            const label = loaded.macro.name || filePath;
            logLocal(`[${k + 1}/${picked.length}] 运行「${label}」……`);
            try {
                const result = await window.electronAPI.runMacro(loaded.macro);
                reportRunResult(result, { fromEditor: false });
                if (result.ok) {
                    okCount += 1;
                } else if (!result.cancelled) {
                    failCount += 1;
                }
                if (result.cancelled) {
                    logLocal('批量运行已被用户停止,后续宏不再执行。');
                    break;
                }
            } catch (e) {
                failCount += 1;
                logLocal(`[${k + 1}/${picked.length}] 运行异常:${(e as Error).message}`, 'error');
            }
            activeRunId = null;
        }
        logLocal(`批量运行结束:成功 ${okCount} 个,失败/跳过 ${failCount} 个。`);
    } finally {
        setBusy(false);
        setMacroLibButtonsDisabled(false);
        activeRunId = null;
        hidePauseModal();
    }
}

macroLibRefreshBtn.addEventListener('click', () => void renderMacroLibrary());
macroLibRunSelectedBtn.addEventListener('click', () => void runSelectedMacros());
macroLibOpenDirBtn.addEventListener('click', () => {
    void window.electronAPI.openMacrosDir();
});

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

// ===== AI 校正选择器 =====
// 让 selector-fix agent 看元素的真实 DOM 上下文,为脆弱选择器(随机 id / 框架动态类名)
// 重挑更稳定的选择器,并在真实录制 webview 里实测「唯一命中被标记的目标元素」后才落地。
// 元素定位:先试步骤当前选择器;失效则用步骤已存的语义指纹(aria/文本/href)重定位。

/** 定位结果 */
interface LocateSnapshot {
    found: boolean;
    /** 命中途径:selector / aria / text / href */
    via?: string;
    /** 目标元素 outerHTML(截断,不含临时标记) */
    outerHTML?: string;
    /** 祖先链摘要(从近到远) */
    ancestors?: string;
}

/**
 * 在录制 webview 内定位步骤对应的元素,给它打临时标记 data-macro-fix,并取上下文快照。
 * 先读 outerHTML 再打标记,保证发给 AI 的 HTML 不含标记。
 */
async function locateAndSnapshot(selector: string, fingerprint: unknown): Promise<LocateSnapshot> {
    const params = { selector, fingerprint: fingerprint ?? null };
    const code =
        '(function(){' +
        'var p=' + JSON.stringify(params) + ';var MARK="data-macro-fix";' +
        'try{var old=document.querySelectorAll("["+MARK+"]");for(var k=0;k<old.length;k++)old[k].removeAttribute(MARK);}catch(e){}' +
        'function q(sel){try{if(sel.indexOf("xpath=")===0){var xr=document.evaluate(sel.slice(6),document,null,7,null);var a=[];for(var i=0;i<xr.snapshotLength;i++){a.push(xr.snapshotItem(i));}return a;}return Array.prototype.slice.call(document.querySelectorAll(sel));}catch(e){return null;}}' +
        'function vis(el){if(!el||el.nodeType!==1)return false;var r=el.getBoundingClientRect();if(r.width<=0&&r.height<=0)return false;var s;try{s=window.getComputedStyle(el);}catch(e){return true;}if(!s)return true;if(s.display==="none"||s.visibility==="hidden"||s.opacity==="0")return false;return true;}' +
        'function uniqVisible(list){if(!list)return null;var v=list.filter(vis);if(v.length===1)return v[0];if(v.length===0&&list.length===1)return list[0];return null;}' +
        'var target=null,via="";' +
        'if(p.selector){var m=q(p.selector);if(m&&m.length===1){target=m[0];via="selector";}}' +
        'if(!target&&p.fingerprint){var fp=p.fingerprint;var got=null;' +
        'if(!got&&fp.ariaLabel){try{got=uniqVisible(Array.prototype.slice.call(document.querySelectorAll("[aria-label="+JSON.stringify(fp.ariaLabel)+"]")));}catch(e){}if(got)via="aria";}' +
        'if(!got&&fp.text){var tag=fp.tag||"*";var all;try{all=document.querySelectorAll(tag);}catch(e){all=document.querySelectorAll("*");}var bt=[];for(var i=0;i<all.length;i++){var el=all[i];var t=(el.textContent||"").replace(/\\s+/g," ").trim();if(t===fp.text)bt.push(el);}got=uniqVisible(bt);if(got)via="text";}' +
        'if(!got&&fp.href){try{got=uniqVisible(Array.prototype.slice.call(document.querySelectorAll("[href="+JSON.stringify(fp.href)+"]")));}catch(e){}if(got)via="href";}' +
        'if(got)target=got;}' +
        'if(!target)return{found:false};' +
        'var outer=target.outerHTML||"";if(outer.length>2000)outer=outer.slice(0,2000)+"…(截断)";' +
        'var lines=[];var node=target.parentElement;var depth=0;' +
        'while(node&&node.nodeType===1&&node.tagName.toLowerCase()!=="html"&&depth<6){' +
        'var seg=node.tagName.toLowerCase();if(node.id)seg+="#"+node.id;var attrs=[];' +
        '["role","aria-label","name","type","data-testid","data-test","data-cy"].forEach(function(a){var val=node.getAttribute&&node.getAttribute(a);if(val)attrs.push(a+"="+JSON.stringify(val));});' +
        'var cls=(node.className&&node.className.baseVal!==undefined)?node.className.baseVal:(typeof node.className==="string"?node.className:"");cls=(cls||"").trim();' +
        'var line=seg;if(attrs.length)line+=" ["+attrs.join(" ")+"]";if(cls)line+=" class=\\""+cls.split(/\\s+/).slice(0,6).join(" ")+"\\"";' +
        'lines.push(line);node=node.parentElement;depth++;}' +
        'target.setAttribute(MARK,"1");' +
        'return{found:true,via:via,outerHTML:outer,ancestors:lines.join("\\n")};})()';
    try {
        const raw = await webview.executeJavaScript(code);
        return (raw && typeof raw === 'object' ? raw : { found: false }) as LocateSnapshot;
    } catch (e) {
        logLocal('定位元素失败(按未找到处理):' + (e as Error).message, 'error');
        return { found: false };
    }
}

/**
 * 实测校正后的选择器:必须恰好命中 1 个且命中了被标记的目标元素。
 * acceptClickable=true(点击步骤)时,命中目标的可点击祖先/后代亦算通过(与离线判定同规则)。
 */
async function verifyFixed(
    selector: string,
    acceptClickable: boolean
): Promise<{ count: number; ok: boolean; invalid: boolean }> {
    const code =
        '(function(){var p=' + JSON.stringify({ selector, acceptClickable }) + ';var MARK="data-macro-fix";' +
        'function q(sel){try{if(sel.indexOf("xpath=")===0){var xr=document.evaluate(sel.slice(6),document,null,7,null);var a=[];for(var i=0;i<xr.snapshotLength;i++){a.push(xr.snapshotItem(i));}return a;}return Array.prototype.slice.call(document.querySelectorAll(sel));}catch(e){return null;}}' +
        'function act(el){var t=el.tagName?el.tagName.toLowerCase():"";if(t==="a"||t==="button")return true;var r=(el.getAttribute&&el.getAttribute("role"))||"";return ["button","link","tab","menuitem","option","checkbox","radio","switch"].indexOf(r)>=0;}' +
        'function hit(mm,tt){if(mm===tt)return true;if(!p.acceptClickable)return false;if(mm.contains(tt)&&act(mm))return true;if(tt.contains(mm))return true;return false;}' +
        'var m=q(p.selector);if(m===null)return{invalid:true,count:0,ok:false};' +
        'var marked=null;try{marked=document.querySelector("["+MARK+"]");}catch(e){}' +
        'return{count:m.length,ok:(m.length===1&&!!marked&&hit(m[0],marked)),invalid:false};})()';
    try {
        const raw = await webview.executeJavaScript(code);
        const r = (raw && typeof raw === 'object' ? raw : {}) as { count?: number; ok?: boolean; invalid?: boolean };
        return { count: r.count ?? 0, ok: !!r.ok, invalid: !!r.invalid };
    } catch {
        return { count: 0, ok: false, invalid: false };
    }
}

/** 清除页面上的临时校正标记(finally 必调) */
async function clearFixMarker(): Promise<void> {
    try {
        await webview.executeJavaScript(
            '(function(){try{var els=document.querySelectorAll("[data-macro-fix]");for(var i=0;i<els.length;i++)els[i].removeAttribute("data-macro-fix");}catch(e){}return true;})()'
        );
    } catch {
        // 非致命
    }
}

/** 选择器是否用了「随交互/校验实时变化」的易变状态属性——这类选择器录制态≠回放态,会命中 0 个致超时 */
function hasVolatileAttr(selector: string): boolean {
    return /\[\s*@?(?:aria-(?:invalid|expanded|selected|checked|pressed|busy|disabled|current)|value)\b/i.test(selector);
}

/** 元素是否「可点击」(点击语义的祖先白名单):tag=a/button 或 role∈交互角色集 */
function isActionable(el: Element): boolean {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'a' || tag === 'button') {
        return true;
    }
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    return ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch'].indexOf(role) >= 0;
}

/**
 * 命中元素 match 是否算「命中了目标 target」。
 * - 严格:match===target。
 * - 点击步骤放宽(acceptClickable):还接受「match 是目标的可点击祖先」或「match 是目标内后代」——
 *   点外层 role=button 与点里层 span 对点击等效;用「可点击」把关,挡掉仅仅包含目标的大容器。
 */
function matchHitsTarget(match: Element, target: Element, acceptClickable: boolean): boolean {
    if (match === target) {
        return true;
    }
    if (!acceptClickable) {
        return false;
    }
    if (match.contains(target) && isActionable(match)) {
        return true; // 可点击祖先
    }
    if (target.contains(match)) {
        return true; // 目标内后代
    }
    return false;
}

/**
 * 离线验证:在录制时抓的邻域子树(contextHtml,目标带 data-macro-cap 标记)里,
 * 校验 AI 新选择器是否「唯一命中且命中了目标」。纯 DOMParser,无 webview、与当前页无关。
 * acceptClickable=true(点击步骤)时,命中目标的可点击祖先/后代亦算通过。
 */
function verifyAgainstCapture(
    selector: string,
    cap: StepCapture,
    acceptClickable: boolean
): { count: number; ok: boolean; invalid: boolean } {
    let doc: Document;
    try {
        doc = new DOMParser().parseFromString(cap.contextHtml, 'text/html');
    } catch {
        return { count: 0, ok: false, invalid: false };
    }
    const target = doc.querySelector('[data-macro-cap]');
    let matches: Element[];
    try {
        if (selector.indexOf('xpath=') === 0) {
            const xr = doc.evaluate(selector.slice(6), doc, null, 7, null);
            matches = [];
            for (let i = 0; i < xr.snapshotLength; i += 1) {
                matches.push(xr.snapshotItem(i) as Element);
            }
        } else {
            matches = Array.from(doc.querySelectorAll(selector));
        }
    } catch {
        return { count: 0, ok: false, invalid: true };
    }
    const ok = matches.length === 1 && !!target && matchHitsTarget(matches[0], target, acceptClickable);
    return { count: matches.length, ok, invalid: false };
}

/**
 * 离线校正(方案 A 主路径):用录制时抓的上下文喂 AI、离线验证,与当前页无关。
 * 元素身份未变故保留原 fingerprint;成功更新 step.selector。
 */
async function fixWithCapture(
    index: number,
    step: Step,
    selector: string,
    cap: StepCapture
): Promise<'fixed' | 'fail'> {
    const reason = '当前选择器疑似含框架动态类名 / 随机 id,回放易失效';
    let feedback: string | undefined;
    let sessionKey: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const res = await window.electronAPI.aiFixSelector({
            current: selector,
            reason,
            elementHtml: cap.outerHTML,
            ancestors: cap.ancestors,
            feedback,
            sessionKey,
        });
        if (!res.ok || !res.selector) {
            logLocal(`步骤 #${index + 1} AI 校正失败:${res.error || '未返回选择器'}`, 'error');
            return 'fail';
        }
        sessionKey = res.sessionKey ?? sessionKey;
        if (hasVolatileAttr(res.selector)) {
            feedback = `选择器 \`${res.selector}\` 用了随交互/校验变化的易变状态属性(如 aria-invalid/value 等),回放时该状态不存在会命中 0 个导致超时。请改用 data-*/id/name/aria-label/可见文本 等稳定锚点重挑。`;
            logLocal(`步骤 #${index + 1} 第 ${attempt} 轮返回含易变状态属性的选择器,带反馈重挑……`);
            continue;
        }
        const v = verifyAgainstCapture(res.selector, cap, step.type === 'click');
        if (v.ok) {
            const old = String(step.selector);
            step.selector = res.selector;
            renderSteps();
            logLocal(`步骤 #${index + 1} 选择器已校正(离线,${attempt} 轮):${old} → ${res.selector}`);
            return 'fixed';
        }
        if (v.invalid) {
            feedback = `选择器 \`${res.selector}\` 是非法选择器,请重挑。`;
        } else if (v.count === 0) {
            feedback = `选择器 \`${res.selector}\` 在给定的元素上下文里命中 0 个(可能引用了上下文之外的锚点),请只用提供的 outerHTML / 祖先链里真实出现的稳定特征,确保唯一命中目标元素。`;
        } else if (v.count > 1) {
            feedback = `选择器 \`${res.selector}\` 命中了 ${v.count} 个元素(不唯一),请缩小到只命中目标元素。`;
        } else {
            feedback = `选择器 \`${res.selector}\` 命中的不是目标元素,请重挑唯一命中目标元素的稳定选择器。`;
        }
        logLocal(`步骤 #${index + 1} 第 ${attempt} 轮离线实测未通过,带反馈重挑……`);
    }
    logLocal(`步骤 #${index + 1} 三轮仍未校正,保留原选择器,请人工核对。`, 'error');
    return 'fail';
}

/** 回退路径(旧宏/无录制上下文):在当前 webview 实时 DOM 上定位+校正(依赖对应页面已加载) */
async function fixWithLiveDom(index: number, step: Step, selector: string): Promise<'fixed' | 'skip' | 'fail'> {
    const snap = await locateAndSnapshot(selector, step.fingerprint);
    if (!snap.found || !snap.outerHTML) {
        logLocal(`步骤 #${index + 1}(${describeStep(step)}):无录制上下文,且当前页找不到该元素,已跳过(请先把对应页面/状态加载到浏览器里,或重录以获得离线上下文)。`);
        return 'skip';
    }
    try {
        const reason = '当前选择器疑似含框架动态类名 / 随机 id,回放易失效';
        let feedback: string | undefined;
        let sessionKey: string | undefined;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const res = await window.electronAPI.aiFixSelector({
                current: selector,
                reason,
                elementHtml: snap.outerHTML,
                ancestors: snap.ancestors,
                feedback,
                sessionKey,
            });
            if (!res.ok || !res.selector) {
                logLocal(`步骤 #${index + 1} AI 校正失败:${res.error || '未返回选择器'}`, 'error');
                return 'fail';
            }
            sessionKey = res.sessionKey ?? sessionKey;
            if (hasVolatileAttr(res.selector)) {
                feedback = `选择器 \`${res.selector}\` 用了随交互/校验变化的易变状态属性(如 aria-invalid/value 等),回放时该状态不存在会命中 0 个导致超时。请改用 data-*/id/name/aria-label/可见文本 等稳定锚点重挑。`;
                logLocal(`步骤 #${index + 1} 第 ${attempt} 轮返回含易变状态属性的选择器,带反馈重挑……`);
                continue;
            }
            const v = await verifyFixed(res.selector, step.type === 'click');
            if (v.ok) {
                const old = String(step.selector);
                step.selector = res.selector;
                renderSteps();
                logLocal(`步骤 #${index + 1} 选择器已校正(${attempt} 轮):${old} → ${res.selector}`);
                return 'fixed';
            }
            if (v.invalid) {
                feedback = `选择器 \`${res.selector}\` 是非法选择器,请重挑。`;
            } else if (v.count === 0) {
                feedback = `选择器 \`${res.selector}\` 在当前页命中 0 个,请重挑唯一命中目标元素的稳定选择器。`;
            } else if (v.count > 1) {
                feedback = `选择器 \`${res.selector}\` 命中了 ${v.count} 个元素(不唯一),请缩小到只命中目标元素。`;
            } else {
                feedback = `选择器 \`${res.selector}\` 命中的不是目标元素,请重挑唯一命中目标元素的稳定选择器。`;
            }
            logLocal(`步骤 #${index + 1} 第 ${attempt} 轮实测未通过,带反馈重挑……`);
        }
        logLocal(`步骤 #${index + 1} 三轮仍未校正,保留原选择器,请人工核对。`, 'error');
        return 'fail';
    } finally {
        await clearFixMarker();
    }
}

/**
 * 对单个步骤做 AI 选择器校正。
 * 有录制上下文(方案 A)→ 离线校正(与当前页无关);无 → 回退实时 DOM(旧宏,需先导航到对应页)。
 */
async function fixStepSelector(index: number): Promise<'fixed' | 'skip' | 'fail'> {
    const step = steps[index];
    const selector = step && step.selector;
    if (typeof selector !== 'string' || !selector) {
        return 'skip';
    }
    const cap = captureOf(step);
    if (cap) {
        return fixWithCapture(index, step, selector, cap);
    }
    return fixWithLiveDom(index, step, selector);
}

// ===== 批量 AI 校正(当前宏所有带选择器的步骤)=====
let fixingAll = false;

/** 批量校正忙态:禁用按钮并切文案 */
function setFixBusy(busy: boolean): void {
    fixingAll = busy;
    aiFixAllBtn.disabled = busy;
    aiFixAllBtn.textContent = busy ? '校正中…' : '🤖 校正全部选择器';
}

/**
 * 遍历当前宏所有带选择器的步骤,逐个 AI 校正。复用单步 fixStepSelector(自动分流:
 * 有录制上下文 → 离线校正、与当前页无关;无上下文 → 回退实时 DOM,当前页找不到元素则计入「跳过」)。
 */
async function fixAllSelectors(): Promise<void> {
    if (fixingAll) {
        return;
    }
    if (recording) {
        logLocal('录制中不能批量校正选择器,请先停止录制。', 'error');
        return;
    }
    const targets: number[] = [];
    steps.forEach((s, i) => {
        if (typeof (s as { selector?: unknown }).selector === 'string' && (s as { selector?: string }).selector) {
            targets.push(i);
        }
    });
    if (!targets.length) {
        logLocal('没有带选择器的步骤可校正。');
        return;
    }
    setFixBusy(true);
    logLocal(`开始 AI 批量校正选择器:共 ${targets.length} 个带选择器的步骤……`);
    let fixed = 0;
    let skip = 0;
    let fail = 0;
    try {
        for (let k = 0; k < targets.length; k += 1) {
            const i = targets[k];
            logLocal(`[${k + 1}/${targets.length}] 正在校正步骤 #${i + 1}……`);
            const r = await fixStepSelector(i);
            if (r === 'fixed') {
                fixed += 1;
            } else if (r === 'skip') {
                skip += 1;
            } else {
                fail += 1;
            }
        }
    } finally {
        setFixBusy(false);
    }
    const tail = autosaveEnabled() && currentMacroPath ? '(改动会自动保存)' : '(改动尚未落盘,请点「保存宏」)';
    logLocal(`AI 批量校正完成:校正 ${fixed} 个、跳过 ${skip} 个、未成功 ${fail} 个。${tail}`);
}

aiFixAllBtn.addEventListener('click', async () => {
    if (fixingAll || recording) {
        return;
    }
    const n = steps.filter(
        (s) =>
            typeof (s as { selector?: unknown }).selector === 'string' &&
            (s as { selector?: string }).selector,
    ).length;
    if (!n) {
        logLocal('没有带选择器的步骤可校正。');
        return;
    }
    const ok = await confirmDialog({
        title: '校正全部选择器',
        message: `将用 AI 逐个校正当前宏中 ${n} 个带选择器的步骤。\n有录制上下文的步骤离线校正,无上下文的需先在浏览器打开对应页面。\n确定继续?`,
        okText: '开始校正',
        cancelText: '取消',
    });
    if (ok) {
        void fixAllSelectors();
    }
});

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
        const context = e.args[1]; // preload 第 2 参:元素 DOM 上下文(离线校正用)
        if (step && typeof step.type === 'string') {
            addStep(step, context);
        }
    } else if (e.channel === 'picker-result') {
        const r = e.args[0] as
            | { selector?: string; fingerprint?: unknown; context?: unknown; cancelled?: boolean }
            | undefined;
        const handler = pendingPick;
        pendingPick = null;
        // 恢复拾取前临时挂起的录制
        if (recording) {
            armRecorder(true);
        }
        // 退出拾取 UI(覆盖「成功点选」与「ESC-in-webview 取消」两条退出路径)
        exitPickingUI();
        if (!r || r.cancelled) {
            logLocal('已取消元素拾取。');
            return;
        }
        if (!r.selector) {
            logLocal('未能为所选元素生成选择器,请重试。', 'error');
            return;
        }
        // 把选择器 + DOM 上下文交给本次拾取的发起方(用途由回调决定)
        if (handler) {
            handler(r.selector, r.fingerprint, r.context);
        }
    }
});

webview.addEventListener('did-navigate', (e: any) => {
    if (e.url) {
        addressInput.value = e.url;
    }
});

// 主窗口级 ESC:焦点在主窗口(工具栏/侧栏等)时按 ESC 也能退出拾取模式。
// 焦点在 webview(guest)内时 ESC 由 preload 处理(不冒泡到此),两路互斥、无重复。
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingPick) {
        e.preventDefault();
        cancelPick();
    }
});

// 录制步骤面板撤销/重做:Ctrl+Z 撤销、Ctrl+Shift+Z 或 Ctrl+Y 重做。
// 焦点在可编辑控件(地址栏/宏名/需求框/JSON 框/内联对话框输入)时放行给浏览器原生文本撤销,不误伤。
// <webview> guest 内的按键不冒泡到宿主 document,故在浏览器里操作不会误触步骤撤销。
document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) {
        return;
    }
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') {
        return;
    }
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
    }
    if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        redoSteps();
    } else if (k === 'z') {
        e.preventDefault();
        undoSteps();
    }
});

// 横幅上的显式取消入口(ESC 之外再兜一层)
pickCancelBtn.addEventListener('click', () => cancelPick());

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

const LOG_HEIGHT_KEY = 'macro.logHeight';
const LOG_MIN = 90; // 日志区最矮
const LOG_MAX_RATIO = 0.6; // 日志区最高不超过整窗高度的 60%,保证上方可见

/** 把日志区高度写到样式(同时设 flex-basis 与 height,覆盖 CSS 固定值) */
function applyLogHeight(logwrap: HTMLElement, h: number): void {
    logwrap.style.flex = '0 0 ' + h + 'px';
    logwrap.style.height = h + 'px';
}

/** 初始化上下分隔条拖动:实时调整日志区高度(向上拖变高),松开后存 localStorage */
function setupLogDivider(): void {
    const divider = document.getElementById('log-divider');
    const app = document.querySelector<HTMLElement>('.app');
    const main = document.querySelector<HTMLElement>('.main');
    const logwrap = document.querySelector<HTMLElement>('.logwrap');
    if (!divider || !app || !main || !logwrap) return;

    const maxHeight = (): number => app.getBoundingClientRect().height * LOG_MAX_RATIO;

    // 启动时恢复上次高度(合法才应用)
    const saved = Number(localStorage.getItem(LOG_HEIGHT_KEY));
    if (Number.isFinite(saved) && saved >= LOG_MIN) {
        applyLogHeight(logwrap, Math.min(saved, maxHeight() || saved));
    }

    const onMove = (e: MouseEvent): void => {
        // 日志区在底部,鼠标越往上(clientY 越小)日志区越高
        let h = app.getBoundingClientRect().bottom - e.clientY;
        h = Math.max(LOG_MIN, Math.min(h, maxHeight()));
        applyLogHeight(logwrap, h);
    };
    const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        main.classList.remove('resizing'); // 复用同一规则遮住 webview 防吞事件
        divider.classList.remove('dragging');
        localStorage.setItem(LOG_HEIGHT_KEY, String(Math.round(logwrap.getBoundingClientRect().height)));
    };
    divider.addEventListener('mousedown', (e) => {
        e.preventDefault();
        main.classList.add('resizing');
        divider.classList.add('dragging');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// ===== 主页简化:高级模式开关 + 「更多」下拉 =====
const ADV_MODE_KEY = 'macro.advancedMode';

/**
 * 高级模式开关:默认关闭,此时隐藏高级面板(提取规则 JSON / 插件 / 登录状态复用),
 * 普通用户只看到核心采集流。仅切换 .sidebar 的 .advanced class(纯 CSS 显隐,
 * 不删节点、不动任何功能),状态记 localStorage 跨会话保留。
 */
function setupAdvancedMode(): void {
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    const toggle = document.getElementById('advanced-mode') as HTMLInputElement | null;
    if (!sidebar || !toggle) return;
    const on = localStorage.getItem(ADV_MODE_KEY) === '1';
    toggle.checked = on;
    sidebar.classList.toggle('advanced', on);
    toggle.addEventListener('change', () => {
        sidebar.classList.toggle('advanced', toggle.checked);
        localStorage.setItem(ADV_MODE_KEY, toggle.checked ? '1' : '0');
    });
}

// 工具栏动作按钮:顺序即优先级;超过「显示数量」且排在后面的自动收进「更多」下拉。
// 改顺序 / 显示数量只改这两个常量即可,溢出规则自动生效。
const TOOLBAR_ACTIONS = ['start', 'stop', 'run', 'stop-run', 'save', 'load', 'ai-fix-all', 'export'];
const MAX_VISIBLE_ACTIONS = 7;

/**
 * 工具栏「更多」下拉:①按规则把超出显示数量的靠后按钮移进下拉(自动溢出),
 * 无溢出则隐藏「更多」;②开合与「点外部收起」。按钮事件均按 id 绑定,移动 DOM 不受影响。
 */
function setupMoreMenu(): void {
    const wrap = document.querySelector<HTMLElement>('.more-wrap');
    const btn = document.getElementById('more-btn');
    const menu = document.getElementById('more-menu');
    if (!wrap || !btn || !menu) return;

    // 溢出:下标 ≥ 显示数量的按钮依次移入「更多」(保持顺序);移动后 .more-wrap 自然落到最后一个可见按钮之后
    const overflow = TOOLBAR_ACTIONS.slice(MAX_VISIBLE_ACTIONS);
    for (const id of overflow) {
        const el = document.getElementById(id);
        if (el) menu.appendChild(el);
    }
    wrap.style.display = menu.childElementCount > 0 ? '' : 'none';

    btn.addEventListener('click', (e) => {
        e.stopPropagation(); // 防冒泡到 document 立即被下面的关闭逻辑收起
        menu.classList.toggle('open');
    });
    menu.addEventListener('click', () => menu.classList.remove('open')); // 选完即收起
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target as Node) && e.target !== btn) {
            menu.classList.remove('open');
        }
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
    setupLogDivider();
    setupAdvancedMode();
    setupMoreMenu();
    window.electronAPI.onLog((msg) => appendLog(msg.message, msg.level, msg.time));
    window.electronAPI.onMacroPaused((info) => showPauseModal(info));
    window.electronAPI.onMacroRunStarted(({ runId }) => {
        activeRunId = runId; // 记录本次运行 runId,供「停止回放」按钮回传
    });
    // 等关键配置加载完成再隐藏遮罩;任一失败也继续(保证遮罩一定会消失)
    await Promise.allSettled([loadAiProfiles(), loadBrowserConfig(), loadPlugins(), renderMacroLibrary()]);
    logLocal('就绪。输入网址后点击「打开网页」,再「开始录制」。');
    hideBootOverlay();
}

void init();
