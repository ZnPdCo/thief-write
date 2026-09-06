import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// 纯逻辑，webview 与宿主共用同一份
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require(path.join(__dirname, '..', 'media', 'session-core.js')) as {
    createState(): { cps: string[] };
    loadSession(state: { cps: string[] }, text: string): void;
    insertText(state: { cps: string[] }, i: number, text: string): void;
    deleteRange(state: { cps: string[] }, a: number, b: number): void;
    sessionText(state: { cps: string[] }): string;
    realContent(state: { cps: string[] }, protectedText: string): string;
};

const LAST_FILE_KEY = 'thiefWrite.lastFile';

class ThiefManager {
    private readonly context: vscode.ExtensionContext;

    private realPath: string | undefined;
    private protectedText = '';
    private state = core.createState();

    // 空串 = 没有伪装源，编辑器按真实字符宽度打码显示
    private decoySource = '';
    private lastSourcePath: string | undefined;
    private lastSourceMtime: number | undefined;
    private recentOn = true;

    private panel: vscode.WebviewPanel | undefined;
    private writeTimer: NodeJS.Timeout | undefined;
    private dirty = false;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.recentOn = this.readRecentSetting();
        this.syncDecoySource();
    }

    private readRecentSetting(): boolean {
        return vscode.workspace
            .getConfiguration('thiefWrite')
            .get<boolean>('recentIndicator', true);
    }

    /** 从设置读取伪装源路径 */
    private readDecoyPathSetting(): string {
        return (
            vscode.workspace
                .getConfiguration('thiefWrite')
                .get<string>('decoySourcePath', '') || ''
        ).trim();
    }

    private stripBom(s: string): string {
        return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    }

    /**
     * 按设置同步伪装源：配了路径就读该文件并缓存（带 mtime 变化检测）；
     * 没配或读不到就置空串，编辑器回退为按宽度打码。
     */
    private syncDecoySource(): void {
        const p = this.readDecoyPathSetting();
        if (!p) {
            if (this.lastSourcePath !== undefined) {
                this.decoySource = '';
                this.lastSourcePath = undefined;
                this.lastSourceMtime = undefined;
            }
            return;
        }
        let mtime: number | undefined;
        let exists = true;
        try {
            mtime = fs.statSync(p).mtimeMs;
        } catch {
            exists = false;
        }
        if (
            exists &&
            this.lastSourcePath === p &&
            this.lastSourceMtime === mtime
        ) {
            return; // 未变化，沿用缓存
        }
        this.lastSourcePath = p;
        this.lastSourceMtime = mtime;
        if (exists) {
            try {
                this.decoySource = this.stripBom(fs.readFileSync(p, 'utf8'));
            } catch {
                this.decoySource = '';
            }
        } else {
            this.decoySource = '';
        }
    }

    /** 伪装源路径设置被改动时同步到面板。 */
    public applyDecoyConfig(): void {
        this.syncDecoySource();
        this.postSource();
    }

    private postSource(): void {
        if (this.panel) {
            void this.panel.webview.postMessage({
                command: 'source',
                source: this.decoySource,
            });
        }
    }

    // 文件选择 / 打开
    private async pickTxtFile(): Promise<string | undefined> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: '选择要写入的文件',
        });
        if (!picked || picked.length === 0) {
            return undefined;
        }
        return picked[0].fsPath;
    }

    private normalizePath(p: string): string {
        if (p.startsWith('~')) {
            const home = process.env.USERPROFILE || process.env.HOME || '~';
            return path.join(home, p.slice(1));
        }
        return p;
    }

    /** 打开上次的文件；无记录或已不存在则弹窗询问。 */
    public async cmdOpenLast(): Promise<void> {
        let p = this.context.globalState.get<string>(LAST_FILE_KEY);
        if (p) {
            p = this.normalizePath(p);
        }
        if (!p || !fs.existsSync(p)) {
            const chosen = await this.pickTxtFile();
            if (!chosen) {
                return;
            }
            p = chosen;
        }
        await this.openPath(p);
    }

    /** 总是弹窗选择文件。 */
    public async cmdOpenFile(): Promise<void> {
        const chosen = await this.pickTxtFile();
        if (!chosen) {
            return;
        }
        await this.openPath(chosen);
    }

    private async openPath(p: string): Promise<void> {
        if (!fs.existsSync(p)) {
            void vscode.window.showWarningMessage(
                `文件不存在：${p}`
            );
            return;
        }
        // 切换目标前，先把当前未落盘内容写回旧文件
        this.flushSync();

        // 同一文件再次打开：只聚焦同步，不重置会话，免得把本次内容误当历史
        if (
            this.realPath &&
            this.panel &&
            this.samePath(this.realPath, p)
        ) {
            this.panel.reveal(vscode.ViewColumn.Active, false);
            this.sendInit();
            return;
        }

        this.realPath = p;
        this.protectedText = this.readText(p);
        this.state = core.createState();
        void this.context.globalState.update(LAST_FILE_KEY, p);

        if (!this.panel) {
            const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
            this.panel = vscode.window.createWebviewPanel(
                'thiefWrite.editor',
                this.titleName(),
                vscode.ViewColumn.Active,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [media],
                }
            );
            this.panel.webview.html = this.getHtml();
            this.panel.onDidDispose(() => {
                this.flushSync();
                this.panel = undefined;
            });
            this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
            // 初始状态等 webview 的 ready 回报
        } else {
            this.panel.title = this.titleName();
            this.sendInit();
        }
    }

    private samePath(a: string, b: string): boolean {
        const ra = path.resolve(a);
        const rb = path.resolve(b);
        if (process.platform === 'win32') {
            return ra.toLowerCase() === rb.toLowerCase();
        }
        return ra === rb;
    }

    private titleName(): string {
        return this.realPath ? path.basename(this.realPath) : 'thief';
    }

    private readText(p: string): string {
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    }

    // 面板
    private getHtml(): string {
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        const cssUri = this.panel!.webview.asWebviewUri(
            vscode.Uri.joinPath(media, 'editor.css')
        );
        const coreUri = this.panel!.webview.asWebviewUri(
            vscode.Uri.joinPath(media, 'session-core.js')
        );
        const jsUri = this.panel!.webview.asWebviewUri(
            vscode.Uri.joinPath(media, 'editor.js')
        );
        const html = fs.readFileSync(
            path.join(this.context.extensionPath, 'media', 'editor.html'),
            'utf8'
        );
        return html
            .replace(/\{\{cspSource\}\}/g, this.panel!.webview.cspSource)
            .replace(/\{\{cssUri\}\}/g, cssUri.toString())
            .replace(/\{\{coreUri\}\}/g, coreUri.toString())
            .replace(/\{\{jsUri\}\}/g, jsUri.toString());
    }

    private sendInit(): void {
        if (!this.panel) {
            return;
        }
        this.syncDecoySource(); // 发 init 前先把伪装源同步一遍
        void this.panel.webview.postMessage({
            command: 'init',
            sessionText: core.sessionText(this.state),
            source: this.decoySource,
            recent: this.recentOn,
        });
        this.focusWebview();
    }

    private focusWebview(): void {
        setTimeout(() => {
            if (this.panel) {
                void this.panel.webview.postMessage({ command: 'focus' });
            }
        }, 120);
    }

    // 来自 webview 的消息
    private onMessage(msg: unknown): void {
        const m = msg as {
            type?: string;
            ops?: Array<{ t?: string; s?: number; e?: number; text?: string }>;
        };
        if (!m || !m.type) {
            return;
        }
        switch (m.type) {
            case 'ready':
                this.sendInit();
                break;
            case 'ops':
                if (Array.isArray(m.ops)) {
                    for (const op of m.ops) {
                        this.applyOp(op);
                    }
                    this.scheduleWrite();
                }
                break;
            case 'flush':
                void this.flushAsync();
                break;
        }
    }

    private applyOp(op: { t?: string; s?: number; e?: number; text?: string }): void {
        if (!op) {
            return;
        }
        if (op.t === 'd') {
            core.deleteRange(this.state, op.s ?? 0, op.e ?? 0);
        } else if (op.t === 'i') {
            core.insertText(this.state, op.s ?? 0, op.text ?? '');
        }
        this.dirty = true;
    }

    // 持久化
    private scheduleWrite(): void {
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
        }
        this.writeTimer = setTimeout(() => {
            this.writeTimer = undefined;
            void this.flushAsync();
        }, 200);
    }

    private async flushAsync(): Promise<void> {
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = undefined;
        }
        if (!this.dirty || !this.realPath) {
            return;
        }
        const content = core.realContent(this.state, this.protectedText);
        const p = this.realPath;
        this.dirty = false;
        this.writeChain = this.writeChain
            .then(() => fs.promises.writeFile(p, content, 'utf8'))
            .catch((err: unknown) => {
                console.error('Thief Write: 写入草稿失败', err);
            });
        await this.writeChain;
    }

    private flushSync(): void {
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = undefined;
        }
        if (!this.dirty || !this.realPath) {
            return;
        }
        const content = core.realContent(this.state, this.protectedText);
        this.dirty = false;
        try {
            fs.writeFileSync(this.realPath, content, 'utf8');
        } catch (err) {
            console.error('Thief Write: 写入草稿失败', err);
        }
    }

    // 其它命令 / 清理
    /** 以明文打开原文件，顶掉 Thief Write 面板所在的窗口。 */
    private async openAsPlain(): Promise<void> {
        this.flushSync();
        let p = this.realPath;
        if (!p) {
            const ed = vscode.window.activeTextEditor;
            if (
                ed &&
                ed.document.uri.scheme === 'file' &&
                fs.existsSync(ed.document.uri.fsPath)
            ) {
                p = ed.document.uri.fsPath;
            }
        }
        if (!p) {
            void vscode.window.showWarningMessage(
                '没有可用的文件（请先用 Thief Write 打开，或在文本编辑器里打开文件）'
            );
            return;
        }

        const col =
            this.panel && this.panel.visible
                ? this.panel.viewColumn
                : undefined;
        await vscode.window.showTextDocument(vscode.Uri.file(p), {
            viewColumn: col ?? vscode.ViewColumn.Active,
            preview: false,
            preserveFocus: false,
        });

        // 替换掉伪装面板（不另开窗口）
        if (this.panel) {
            const pan = this.panel;
            this.panel = undefined;
            pan.dispose();
        }
    }

    /** 把“当前明文编辑器里的文件”切换成 Thief Write 模式，替换当前窗口。 */
    private async openCurrentAsThief(): Promise<void> {
        const ed = vscode.window.activeTextEditor;
        if (!ed || ed.document.uri.scheme !== 'file') {
            void vscode.window.showWarningMessage(
                '请先在文本编辑器里打开一个文件'
            );
            return;
        }
        const p = ed.document.uri.fsPath;
        if (!fs.existsSync(p)) {
            return;
        }
        // 关闭当前明文窗口，由伪编辑器接管该位置
        if (ed === vscode.window.activeTextEditor) {
            await vscode.commands.executeCommand(
                'workbench.action.closeActiveEditor'
            );
        }
        await this.openPath(p);
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active, false);
        }
    }

    /** 切换右下角“最近字符”提示，并持久化到设置。 */
    public async cmdToggleRecent(): Promise<void> {
        this.recentOn = !this.recentOn;
        await vscode.workspace
            .getConfiguration('thiefWrite')
            .update(
                'recentIndicator',
                this.recentOn,
                vscode.ConfigurationTarget.Global
            );
        this.postRecent();
    }

    /** 设置被改动时同步到面板。 */
    public applyRecentConfig(): void {
        this.recentOn = this.readRecentSetting();
        this.postRecent();
    }

    private postRecent(): void {
        if (this.panel) {
            void this.panel.webview.postMessage({
                command: 'recent',
                recent: this.recentOn,
            });
        }
    }

    /** 单一快捷键：在伪编辑器与明文之间来回切换。 */
    public async cmdToggle(): Promise<void> {
        // 正看着伪编辑器 → 切到明文
        if (this.panel && this.panel.visible) {
            await this.openAsPlain();
            return;
        }
        // 有明文编辑器 → 切回 Thief Write
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document.uri.scheme === 'file') {
            await this.openCurrentAsThief();
            return;
        }
        // 伪编辑器在后台 → 呼出来
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active, false);
            this.sendInit();
            return;
        }
        // 兜底：打开上次的文件
        await this.cmdOpenLast();
    }

    public async cmdChooseDecoySource(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: '选择伪装文本源',
        });
        if (!picked || picked.length === 0) {
            return;
        }
        try {
            const text = this.stripBom(fs.readFileSync(picked[0].fsPath, 'utf8'));
            this.decoySource = text;
            this.lastSourcePath = picked[0].fsPath;
            this.lastSourceMtime = fs.statSync(picked[0].fsPath).mtimeMs;
            // 持久化到设置：下次启动 / 其它窗口仍使用同一伪装源
            await vscode.workspace
                .getConfiguration('thiefWrite')
                .update(
                    'decoySourcePath',
                    picked[0].fsPath,
                    vscode.ConfigurationTarget.Global
                );
            this.postSource();
            void vscode.window.showInformationMessage(
                `伪装文本源已设为并保存：${path.basename(picked[0].fsPath)}`
            );
        } catch (err) {
            void vscode.window.showErrorMessage(
                `读取伪装源失败：${String(err)}`
            );
        }
    }

    /** 清掉伪装源设置 */
    public async cmdClearDecoySource(): Promise<void> {
        await vscode.workspace
            .getConfiguration('thiefWrite')
            .update('decoySourcePath', '', vscode.ConfigurationTarget.Global);
        this.syncDecoySource();
        this.postSource();
        void vscode.window.showInformationMessage(
            '伪装文本源已清除，改为占位符显示'
        );
    }

    public async cmdStop(): Promise<void> {
        this.flushSync();
        if (this.panel) {
            this.panel.dispose();
            this.panel = undefined;
        }
    }

    public async dispose(): Promise<void> {
        this.flushSync();
        if (this.panel) {
            this.panel.dispose();
            this.panel = undefined;
        }
    }
}

// 激活 / 注销
let manager: ThiefManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
    manager = new ThiefManager(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('thief.openLast', () => manager?.cmdOpenLast()),
        vscode.commands.registerCommand('thief.openFile', () => manager?.cmdOpenFile()),
        vscode.commands.registerCommand('thief.toggle', () => manager?.cmdToggle()),
        vscode.commands.registerCommand('thief.stop', () => manager?.cmdStop()),
        vscode.commands.registerCommand('thief.toggleRecent', () =>
            manager?.cmdToggleRecent()
        ),
        vscode.commands.registerCommand('thief.chooseDecoySource', () =>
            manager?.cmdChooseDecoySource()
        ),
        vscode.commands.registerCommand('thief.clearDecoySource', () =>
            manager?.cmdClearDecoySource()
        )
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!manager) {
                return;
            }
            if (e.affectsConfiguration('thiefWrite.recentIndicator')) {
                manager.applyRecentConfig();
            }
            if (e.affectsConfiguration('thiefWrite.decoySourcePath')) {
                manager.applyDecoyConfig();
            }
        })
    );
}

export async function deactivate(): Promise<void> {
    if (manager) {
        await manager.dispose();
    }
    manager = undefined;
}
