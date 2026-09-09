import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { StealthFileSystemProvider } from './stealthFileSystemProvider';
import { saveDocIfDirty } from './utils';

export class StealthEditor {
    constructor(private readonly provider: StealthFileSystemProvider) {}

    private buildFakeUri(realPath: string, displayName: string): vscode.Uri {
        const hash = crypto
            .createHash('sha1')
            .update(path.resolve(realPath))
            .digest('hex')
            .slice(0, 16);
        return vscode.Uri.from({
            scheme: 'stealth',
            path: `/${hash}/${displayName}`,
        });
    }

    /** 关闭指定文档对应的标签页 */
    async closeDoc(doc: vscode.TextDocument): Promise<void> {
        await saveDocIfDirty(doc);
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
                // 忽略被手动关闭异常
            }
        }
    }

    /** 打开（或唤起）stealth 文档，支持传递恢复状态（光标与视口） */
    async openStealth(
        realRaw: string,
        displayName: string,
        restoreState?: { selection: vscode.Selection; visibleRange?: vscode.Range }
    ): Promise<vscode.TextEditor> {
        const realPath = path.resolve(realRaw);
        const fakeUri = this.buildFakeUri(realPath, displayName);
        this.provider.map(fakeUri, realPath);

        const doc = await vscode.workspace.openTextDocument(fakeUri);
        await vscode.languages.setTextDocumentLanguage(doc, 'stealth-text');

        // preview: true 让新文档替换当前 tab，避免闪烁和窗口缩放
        const editor = await vscode.window.showTextDocument(doc, {
            preview: true,
            preserveFocus: false,
        });

        if (restoreState) {
            editor.selection = restoreState.selection;
            if (restoreState.visibleRange) {
                editor.revealRange(restoreState.visibleRange, vscode.TextEditorRevealType.AtTop);
            }
        }

        return editor;
    }

    /** 进入隐写：当前真实文件 -> 隐写视图 */
    async enterStealth(sourceDoc: vscode.TextDocument, selection?: vscode.Selection): Promise<void> {
        const realPath = path.resolve(sourceDoc.uri.fsPath);
        if (!fs.existsSync(realPath)) {
            void vscode.window.showWarningMessage(`文件不存在：${realPath}`);
            return;
        }

        await saveDocIfDirty(sourceDoc);

        // 先记录源文件的编辑器状态（此时源文件仍是活动编辑器）
        const sourceEditor = vscode.window.activeTextEditor;
        const visibleRange = sourceEditor?.visibleRanges[0];
        const sel = selection || sourceEditor?.selection || new vscode.Selection(0, 0, 0, 0);

        // preview: true 直接替换当前 tab，不闪烁
        await this.openStealth(realPath, path.basename(realPath), {
            selection: sel,
            visibleRange,
        });

        // 新文档已替换旧 tab，再关掉源文件标签
        await this.closeDoc(sourceDoc);
    }

    /** 退出隐写：隐写文档 -> 回到真实明文文档 */
    async exitToPlain(stealthDoc: vscode.TextDocument): Promise<void> {
        const realPath = this.provider.realPathFor(stealthDoc.uri);
        if (!realPath) {
            void vscode.window.showWarningMessage('找不到对应的真实文件');
            return;
        }

        await saveDocIfDirty(stealthDoc);

        // 先记录隐写文档的光标状态（此时编辑器仍是隐写文档）
        const stealthEd = vscode.window.activeTextEditor;
        const curSelection = stealthEd?.selection;
        const curVisibleRange = stealthEd?.visibleRanges[0];

        // preview: true 直接替换当前 tab
        const realUri = vscode.Uri.file(realPath);
        const pdoc = await vscode.workspace.openTextDocument(realUri);
        const editor = await vscode.window.showTextDocument(pdoc, {
            preview: true,
            preserveFocus: false,
        });

        if (curSelection) {
            editor.selection = curSelection;
        }
        if (curVisibleRange) {
            editor.revealRange(curVisibleRange, vscode.TextEditorRevealType.AtTop);
        }

        // 新文档已替换旧 tab，再关掉 stealth 标签
        await this.closeDoc(stealthDoc);
        this.provider.unmap(stealthDoc.uri);
    }

    /** 切换标签显示名，保持当前光标及视口位置不变 */
    async renameDisplay(
        current: vscode.TextDocument,
        newDisplay: string
    ): Promise<void> {
        const realPath = this.provider.realPathFor(current.uri);
        if (!realPath) {
            void vscode.window.showWarningMessage('找不到对应的真实文件');
            return;
        }

        // 先记录当前状态（此时编辑器仍指向旧文档）
        const curEditor = vscode.window.activeTextEditor;
        const state = curEditor
            ? { selection: curEditor.selection, visibleRange: curEditor.visibleRanges[0] }
            : undefined;

        await saveDocIfDirty(current);
        this.provider.unmap(current.uri);

        // preview: true 直接替换当前 tab
        await this.openStealth(realPath, newDisplay, state);

        // 新文档已替换旧 tab，再关掉旧 stealth 标签
        await this.closeDoc(current);
    }
}
