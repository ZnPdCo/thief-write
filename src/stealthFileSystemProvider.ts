import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * 虚拟文件系统：把「stealth:」伪装 URI 映射到磁盘上的真实文件。
 * VS Code 对 stealth 文档的原生 Ctrl+S 会调用 writeFile()，由我们把内容落盘到真实文件；
 * 撤销/重做、脏标记（isDirty）、IME 全部由 VS Code 原生承担。
 */
export class StealthFileSystemProvider implements vscode.FileSystemProvider {
    private readonly mapping = new Map<string, string>();
    private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    realPathFor(uri: vscode.Uri): string | undefined {
        return this.mapping.get(uri.toString());
    }

    map(uri: vscode.Uri, realPath: string): void {
        this.mapping.set(uri.toString(), path.resolve(realPath));
    }

    unmap(uri: vscode.Uri): void {
        this.mapping.delete(uri.toString());
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const real = this.realPathFor(uri);
        if (!real) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        try {
            const s = fs.statSync(real);
            return {
                type: vscode.FileType.File,
                ctime: s.ctimeMs,
                mtime: s.mtimeMs,
                size: s.size,
            };
        } catch {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    readDirectory(): [string, vscode.FileType][] {
        return [];
    }

    createDirectory(): void {
        throw vscode.FileSystemError.NoPermissions('只读虚拟文件系统');
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
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    delete(): void {
        throw vscode.FileSystemError.NoPermissions('只读虚拟文件系统');
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions('只读虚拟文件系统');
    }
}
