import * as vscode from 'vscode';
import { ThiefManager } from './thiefManager';

let manager: ThiefManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
    manager = new ThiefManager(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('thief.toggle', () => manager?.cmdToggle()),
        vscode.commands.registerCommand('thief.toggleName', () => manager?.cmdToggleName()),
        vscode.commands.registerCommand('thief.toggleRecent', () => manager?.cmdToggleRecent()),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('thiefWrite.recentIndicator')) {
                manager?.applyRecentConfig();
            }
        })
    );
}

export function deactivate(): void {
    manager = undefined;
}
