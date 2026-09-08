import * as path from 'path';
import * as vscode from 'vscode';


/** 格式化字符展示，避免特殊不可见字符或空白让人困惑 */
export function fmtChar(ch: string): string {
    if (ch === '\n' || ch === '\r') {
        return '⏎';
    }
    if (ch === '\t') {
        return '⇥';
    }
    if (ch === ' ') {
        return '␣';
    }
    return ch || ' ';
}

/** 伪装名配置获取 */
export function readDisguiseName(): string {
    const name = vscode.workspace
        .getConfiguration('thiefWrite')
        .get<string>('displayName');
    const base = (name || '').trim();
    return base ? path.basename(base) : 'Untitled-1';
}

/** 安全保存文档 */
export async function saveDocIfDirty(doc?: vscode.TextDocument): Promise<void> {
    if (doc && doc.isDirty) {
        await doc.save();
    }
}
