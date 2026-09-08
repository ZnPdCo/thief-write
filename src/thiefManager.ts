import * as path from 'path';
import * as vscode from 'vscode';
import { StealthEditor } from './stealthEditor';
import { StealthFileSystemProvider } from './stealthFileSystemProvider';
import { fmtChar, readDisguiseName } from './utils';

export class ThiefManager {
    private readonly editor: StealthEditor;
    private readonly provider: StealthFileSystemProvider;
    private readonly status: vscode.StatusBarItem;
    private recentOn: boolean;

    constructor(context: vscode.ExtensionContext) {
        this.recentOn = this.readRecentSetting();

        this.provider = new StealthFileSystemProvider();
        context.subscriptions.push(
            vscode.workspace.registerFileSystemProvider('stealth', this.provider)
        );

        this.editor = new StealthEditor(this.provider);

        this.status = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.status.tooltip = 'Thief Write：光标两侧的真实字符 [左 | 右]';

        context.subscriptions.push(
            this.status,
            vscode.window.onDidChangeTextEditorSelection(() => this.updateStatus()),
            vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus())
        );
    }

    private readRecentSetting(): boolean {
        return vscode.workspace
            .getConfiguration('thiefWrite')
            .get<boolean>('recentIndicator', true);
    }

    /** Ctrl+Alt+T：在隐写视图与真实文件明文之间切换。 */
    public async cmdToggle(): Promise<void> {
        const ed = vscode.window.activeTextEditor;
        if (!ed) {
            void vscode.window.showInformationMessage('Thief Write：请先打开一个真实文件');
            return;
        }

        if (ed.document.uri.scheme === 'stealth') {
            await this.editor.exitToPlain(ed.document);
            this.updateStatus();
            return;
        }

        if (ed.document.uri.scheme === 'file') {
            await this.editor.enterStealth(ed.document, ed.selection);
            this.updateStatus();
            return;
        }

        void vscode.window.showInformationMessage('Thief Write：仅支持本地真实文件');
    }

    /** 切换隐写标签显示名：真实文件名 <-> 伪装名。 */
    public async cmdToggleName(): Promise<void> {
        const ed = vscode.window.activeTextEditor;
        if (!ed || ed.document.uri.scheme !== 'stealth') {
            void vscode.window.showInformationMessage('Thief Write：仅在隐写视图可用');
            return;
        }

        const doc = ed.document;
        const realPath = this.provider.realPathFor(doc.uri);
        if (!realPath) {
            void vscode.window.showWarningMessage('找不到对应的真实文件');
            return;
        }

        const curName = path.posix.basename(doc.uri.path);
        const realName = path.basename(realPath);
        const disguise = readDisguiseName();
        const want = curName === disguise ? realName : disguise;

        await this.editor.renameDisplay(doc, want);
        this.updateStatus();
    }

    public async cmdToggleRecent(): Promise<void> {
        this.recentOn = !this.recentOn;
        await vscode.workspace
            .getConfiguration('thiefWrite')
            .update('recentIndicator', this.recentOn, vscode.ConfigurationTarget.Global);
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
            ed.document.uri.scheme !== 'stealth' ||
            !this.provider.realPathFor(ed.document.uri)
        ) {
            this.status.hide();
            return;
        }

        const doc = ed.document;
        const pos = ed.selection.active;
        const line = doc.lineAt(pos.line);
        const lineText = line.text;

        let left = '';
        if (pos.character > 0) {
            const end = pos.character;
            const tail = lineText.slice(Math.max(0, end - 2), end);
            const chars = Array.from(tail);
            left = chars[chars.length - 1] || '';
        } else if (pos.line > 0) {
            left = '\n';
        }

        let right = '';
        if (pos.character < lineText.length) {
            const head = lineText.slice(pos.character, pos.character + 2);
            const chars = Array.from(head);
            right = chars[0] || '';
        } else if (pos.line < doc.lineCount - 1) {
            right = '\n';
        }

        this.status.text = `[ ${fmtChar(left)} | ${fmtChar(right)} ]`;
        this.status.show();
    }
}
