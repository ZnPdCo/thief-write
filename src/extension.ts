import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const SCHEME = 'stealth';
const STEALTH_LANG = 'stealth-text';

function fmtChar(ch: string): string {
    if (ch === '\n' || ch === '\r') {
        return '⏎';
    }
    return ch;
}

/** 伪装名（可从设置 thiefWrite.displayName 自定义，默认“新建文本文件.txt”）。 */
function readDisguiseName(): string {
    const name = vscode.workspace
        .getConfiguration('thiefWrite')
        .get<string>('displayName', '新建文本文件.txt');
    const base = (name || '').trim();
    if (!base) {
        return '新建文本文件.txt';
    }
    return path.basename(base); // 只取文件名部分，防目录穿越
}

/** URI path 最后一段，用作标签显示名。 */
function uriBasename(uri: vscode.Uri): string {
    const seg = uri.path.split('/');
    return seg[seg.length - 1] || '';
}

/**
 * 虚拟文件系统：把「stealth:」伪装 URI 映射到磁盘上的真实文件。
 * VS Code 对 stealth 文档的原生 Ctrl+S 会调用 writeFile()，由我们把内容落盘到真实文件；
 * 撤销/重做、脏标记（isDirty）、IME 全部由 VS Code 原生承担。
 */
class StealthFileSystemProvider implements vscode.FileSystemProvider {
    private readonly mapping = new Map<string, string>();
    private readonly em = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.em.event;

    watch(
        _uri: vscode.Uri,
        _options: { recursive: boolean; excludes: string[] }
    ): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    realPathFor(uri: vscode.Uri): string | undefined {
        return this.mapping.get(uri.toString());
    }

    map(uri: vscode.Uri, realPath: string): void {
        this.mapping.set(uri.toString(), path.resolve(realPath));
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const real = this.realPathFor(uri);
        if (real) {
            try {
                const s = fs.statSync(real);
                return {
                    type: vscode.FileType.File,
                    ctime: s.ctimeMs,
                    mtime: s.mtimeMs,
                    size: s.size,
                };
            } catch {
                return {
                    type: vscode.FileType.File,
                    ctime: 0,
                    mtime: 0,
                    size: 0,
                };
            }
        }
        return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }

    readDirectory(): [string, vscode.FileType][] {
        return [];
    }

    createDirectory(): void {
        throw vscode.FileSystemError.NoPermissions('read-only virtual provider');
    }

    readFile(uri: vscode.Uri): Uint8Array {
        const real = this.realPathFor(uri);
        if (!real) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return new Uint8Array(fs.readFileSync(real));
    }

    writeFile(
        uri: vscode.Uri,
        content: Uint8Array,
        _options: { create: boolean; overwrite: boolean }
    ): void {
        const real = this.realPathFor(uri);
        if (!real) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        fs.writeFileSync(real, Buffer.from(content));
    }

    delete(): void {
        throw vscode.FileSystemError.NoPermissions('read-only virtual provider');
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions('read-only virtual provider');
    }
}

class ThiefManager {
    private readonly context: vscode.ExtensionContext;
    private readonly provider: StealthFileSystemProvider;
    private readonly status: vscode.StatusBarItem;

    private recentOn: boolean;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.recentOn = this.readRecentSetting();

        this.provider = new StealthFileSystemProvider();
        context.subscriptions.push(
            vscode.workspace.registerFileSystemProvider(SCHEME, this.provider)
        );

        this.status = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.status.tooltip = 'Thief Write：光标两侧的真实字符';

        context.subscriptions.push(
            this.status,
            vscode.window.onDidChangeTextEditorSelection(() =>
                this.updateStatus()
            ),
            vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus())
        );
    }

    private readRecentSetting(): boolean {
        return vscode.workspace
            .getConfiguration('thiefWrite')
            .get<boolean>('recentIndicator', true);
    }

    private buildFakeUri(realPath: string, displayName: string): vscode.Uri {
        const hash = crypto
            .createHash('sha1')
            .update(path.resolve(realPath))
            .digest('hex')
            .slice(0, 16);
        return vscode.Uri.from({
            scheme: SCHEME,
            path: `/thief/${hash}/${displayName}`,
        });
    }

    private async saveActiveIfDirty(): Promise<void> {
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document.isDirty) {
            await vscode.commands.executeCommand('workbench.action.files.save');
        }
    }

    /** 关闭指定文档对应的标签页（必要时先保存）。映射保留，供重开/Ctrl+Shift+T 使用。 */
    private async closeDoc(doc: vscode.TextDocument): Promise<void> {
        if (doc.isDirty) {
            await vscode.window.showTextDocument(doc, {
                preview: false,
                preserveFocus: false,
            });
            await vscode.commands.executeCommand('workbench.action.files.save');
        }
        const tab = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .find(
                (t) =>
                    t.input instanceof vscode.TabInputText &&
                    t.input.uri.toString() === doc.uri.toString()
            );
        if (tab) {
            try {
                await vscode.window.tabGroups.close(tab, true);
            } catch {
                // 忽略关闭失败（例如已被用户手动关掉）
            }
        }
    }

    private async closeAllStealthDocs(): Promise<void> {
        for (const doc of [
            ...vscode.workspace.textDocuments,
        ]) {
            if (doc.uri.scheme === SCHEME) {
                await this.closeDoc(doc);
            }
        }
    }

    /** 打开（或唤起）指定真实文件的 stealth 文档，并使其成为当前激活视图。 */
    private async openStealth(
        realRaw: string,
        displayName: string
    ): Promise<void> {
        const realPath = path.resolve(realRaw);
        const fakeUri = this.buildFakeUri(realPath, displayName);
        this.provider.map(fakeUri, realPath);

        // 该 URI 的标签仍在：直接唤起，不做重建
        const openTab = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .find(
                (t) =>
                    t.input instanceof vscode.TabInputText &&
                    t.input.uri.toString() === fakeUri.toString()
            );
        if (openTab) {
            const doc = await vscode.workspace.openTextDocument(fakeUri);
            await vscode.window.showTextDocument(doc, {
                preview: false,
                preserveFocus: false,
            });
            this.updateStatus();
            return;
        }

        const doc = await vscode.workspace.openTextDocument(fakeUri);
        await vscode.languages.setTextDocumentLanguage(doc, STEALTH_LANG);
        await vscode.window.showTextDocument(doc, {
            preview: false,
            preserveFocus: false,
        });
        // 文档干净时从 Provider 重读一次磁盘，避免复用缓存造成内容陈旧
        // （真实文件在退出隐写期间可能被明文视图改过并保存）
        if (!doc.isDirty) {
            try {
                await vscode.commands.executeCommand(
                    'workbench.action.files.revert'
                );
            } catch {
                // revert 失败不影响打开
            }
        }
        this.updateStatus();
    }

    /** 进入隐写：真实文件（默认同名显示）→ 替换当前视图。 */
    private async enterStealth(realRaw: string): Promise<void> {
        const realPath = path.resolve(realRaw);
        if (!fs.existsSync(realPath)) {
            void vscode.window.showWarningMessage(`文件不存在：${realPath}`);
            return;
        }
        await this.saveActiveIfDirty();
        await this.closeAllStealthDocs();
        await this.openStealth(realPath, path.basename(realPath));
    }

    /** 退出隐写：关闭假文档，打开真实文件明文视图。 */
    private async exitToPlain(stealthDoc: vscode.TextDocument): Promise<void> {
        const realPath = this.provider.realPathFor(stealthDoc.uri);
        if (!realPath) {
            void vscode.window.showWarningMessage('找不到对应的真实文件');
            return;
        }
        await this.saveActiveIfDirty();
        const realUri = vscode.Uri.file(realPath);
        const pdoc = await vscode.workspace.openTextDocument(realUri);
        await vscode.window.showTextDocument(pdoc, {
            preview: false,
            preserveFocus: false,
        });
        await this.closeDoc(stealthDoc);
        this.updateStatus();
    }

    /** 把当前隐写标签的显示名切到另一个名字（原名 <-> 伪装名）。 */
    private async renameDisplay(
        current: vscode.TextDocument,
        newDisplay: string
    ): Promise<void> {
        const realPath = this.provider.realPathFor(current.uri);
        if (!realPath) {
            void vscode.window.showWarningMessage('找不到对应的真实文件');
            return;
        }
        if (uriBasename(current.uri) === newDisplay) {
            return;
        }
        await this.saveActiveIfDirty();
        await this.openStealth(realPath, newDisplay);
        await this.closeDoc(current);
        this.updateStatus();
    }

    // 命令
    /** Ctrl+Alt+T：在隐写视图与真实文件明文之间切换。 */
    public async cmdToggle(): Promise<void> {
        const ed = vscode.window.activeTextEditor;
        if (!ed) {
            void vscode.window.showInformationMessage(
                'Thief Write：请先打开一个真实文件'
            );
            return;
        }
        if (ed.document.uri.scheme === SCHEME) {
            await this.exitToPlain(ed.document);
            return;
        }
        if (ed.document.uri.scheme === 'file') {
            const source = ed.document;
            await this.enterStealth(source.uri.fsPath);
            await this.closeDoc(source);
            return;
        }
        void vscode.window.showInformationMessage(
            'Thief Write：请先打开一个真实文件'
        );
    }

    /** 切换隐写标签显示名：真实文件名 <-> 伪装名。 */
    public async cmdToggleName(): Promise<void> {
        const ed = vscode.window.activeTextEditor;
        if (!ed || ed.document.uri.scheme !== SCHEME) {
            void vscode.window.showInformationMessage(
                'Thief Write：仅在隐写视图可用（Ctrl+Alt+T 进入）'
            );
            return;
        }
        const doc = ed.document;
        const realPath = this.provider.realPathFor(doc.uri);
        if (!realPath) {
            void vscode.window.showWarningMessage('找不到对应的真实文件');
            return;
        }
        const cur = uriBasename(doc.uri);
        const realName = path.basename(realPath);
        const disguise = readDisguiseName();
        const want = cur === disguise ? realName : disguise;
        await this.renameDisplay(doc, want);
    }

    public async cmdToggleRecent(): Promise<void> {
        this.recentOn = !this.recentOn;
        await vscode.workspace
            .getConfiguration('thiefWrite')
            .update(
                'recentIndicator',
                this.recentOn,
                vscode.ConfigurationTarget.Global
            );
        this.updateStatus();
    }

    public applyRecentConfig(): void {
        this.recentOn = this.readRecentSetting();
        this.updateStatus();
    }

    /** 右下角状态栏：仅当激活编辑器是 stealth 文档时显示 [ 左 | 右 ]。 */
    private updateStatus(): void {
        const ed = vscode.window.activeTextEditor;
        if (
            !this.recentOn ||
            !ed ||
            ed.document.uri.scheme !== SCHEME ||
            !this.provider.realPathFor(ed.document.uri)
        ) {
            this.status.hide();
            return;
        }
        const doc = ed.document;
        const text = doc.getText();
        const off = doc.offsetAt(ed.selection.active);
        const left = off > 0 ? text.charAt(off - 1) : '';
        const right = off < text.length ? text.charAt(off) : '';
        this.status.text = `[ ${fmtChar(left)} | ${fmtChar(right)} ]`;
        this.status.show();
    }

    public dispose(): void {
        // 无需主动清理：扩展卸载时 provider 与映射随之销毁
    }
}

// 激活 / 注销
let manager: ThiefManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
    manager = new ThiefManager(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('thief.toggle', () => manager?.cmdToggle()),
        vscode.commands.registerCommand('thief.toggleName', () =>
            manager?.cmdToggleName()
        ),
        vscode.commands.registerCommand('thief.toggleRecent', () =>
            manager?.cmdToggleRecent()
        ),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!manager) {
                return;
            }
            if (e.affectsConfiguration('thiefWrite.recentIndicator')) {
                manager.applyRecentConfig();
            }
        })
    );
}

export function deactivate(): void {
    manager?.dispose();
    manager = undefined;
}
