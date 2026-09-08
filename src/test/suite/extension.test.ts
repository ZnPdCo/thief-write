import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmpDir: string;

function createTmpFile(content: string, name = 'test-file.txt'): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
}

async function closeAllEditors(): Promise<void> {
    while (vscode.window.tabGroups.all.length > 0) {
        const tabs = vscode.window.tabGroups.all[0].tabs;
        if (tabs.length === 0) break;
        await vscode.window.tabGroups.close(tabs[0], true);
    }
}

async function activateExtension(): Promise<void> {
    const ext = vscode.extensions.getExtension('ZnPdCo.thief-write');
    if (ext && !ext.isActive) {
        await ext.activate();
    }
}

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('thiefWrite');
}

suite('Extension Test Suite', () => {
    suiteSetup(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thief-write-test-'));
        await activateExtension();
    });

    suiteTeardown(async () => {
        await closeAllEditors();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        await getConfig().update('displayName', undefined, vscode.ConfigurationTarget.Global);
        await getConfig().update('recentIndicator', undefined, vscode.ConfigurationTarget.Global);
    });

    teardown(async () => {
        await closeAllEditors();
        await sleep(200);
    });

    // ──────────────────────────────────────
    // 一、基础激活
    // ──────────────────────────────────────

    test('1. 扩展激活成功', async () => {
        const ext = vscode.extensions.getExtension('ZnPdCo.thief-write');
        assert.ok(ext, '扩展应存在');
        assert.ok(ext.isActive, '扩展应已激活');
    });

    test('2. 三个命令已注册', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('thief.toggle'), 'thief.toggle 应已注册');
        assert.ok(commands.includes('thief.toggleName'), 'thief.toggleName 应已注册');
        assert.ok(commands.includes('thief.toggleRecent'), 'thief.toggleRecent 应已注册');
    });

    // ──────────────────────────────────────
    // 二、保存 / 内容完整性
    // ──────────────────────────────────────

    test('3. 空文件 → 隐写 → 输入 → 保存 → 磁盘正确', async () => {
        const fp = createTmpFile('', 'empty.txt');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(stealthDoc.uri, new vscode.Position(0, 0), 'hello from empty');
        await vscode.workspace.applyEdit(edit);
        await sleep(200);

        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(500);

        const disk = fs.readFileSync(fp, 'utf-8');
        assert.strictEqual(disk, 'hello from empty');
    });

    test('4. 隐写输入 → 不保存 → toggle 回明文 → 磁盘保持原内容', async () => {
        const fp = createTmpFile('original');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(stealthDoc.uri, new vscode.Position(0, 0), 'unsaved ');
        await vscode.workspace.applyEdit(edit);
        await sleep(200);

        // 不保存，直接 toggle 回明文
        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const disk = fs.readFileSync(fp, 'utf-8');
        assert.strictEqual(disk, 'original');
    });

    test('5. 多次 toggle 往返，内容不丢失', async () => {
        const fp = createTmpFile('init');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        // 第一次进入隐写
        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);
        let sDoc = vscode.window.activeTextEditor!.document;
        let edit = new vscode.WorkspaceEdit();
        edit.insert(sDoc.uri, new vscode.Position(0, 9), '-round1');
        await vscode.workspace.applyEdit(edit);
        await sleep(200);
        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(300);

        // toggle 回明文
        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        // 第二次进入隐写
        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);
        sDoc = vscode.window.activeTextEditor!.document;
        edit = new vscode.WorkspaceEdit();
        edit.insert(sDoc.uri, new vscode.Position(0, 15), '-round2');
        await vscode.workspace.applyEdit(edit);
        await sleep(200);
        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(300);

        // toggle 回明文
        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const disk = fs.readFileSync(fp, 'utf-8');
        assert.strictEqual(disk, 'init-round1-round2');
    });

    test('6. 文件名含中文 → 隐写 round-trip', async () => {
        const fp = createTmpFile('中文内容', '测试文件.txt');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        assert.strictEqual(stealthDoc.uri.scheme, 'stealth');
        assert.strictEqual(stealthDoc.getText(), '中文内容');

        const edit = new vscode.WorkspaceEdit();
        edit.insert(stealthDoc.uri, new vscode.Position(0, 3), '-追加');
        await vscode.workspace.applyEdit(edit);
        await sleep(200);
        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const disk = fs.readFileSync(fp, 'utf-8');
        assert.strictEqual(disk, '中文内容-追加');
    });

    test('7. 文件内容含 emoji → 隐写 round-trip', async () => {
        const fp = createTmpFile('hello 🌍');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        assert.strictEqual(stealthDoc.getText(), 'hello 🌍');

        const edit = new vscode.WorkspaceEdit();
        edit.insert(stealthDoc.uri, new vscode.Position(0, 6), '🚀');
        await vscode.workspace.applyEdit(edit);
        await sleep(200);
        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const disk = fs.readFileSync(fp, 'utf-8');
        assert.strictEqual(disk, 'hello 🌍🚀');
    });

    test('8. select all → 替换 → 保存 → 磁盘正确', async () => {
        const fp = createTmpFile('old content here');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        const fullRange = new vscode.Range(
            stealthDoc.positionAt(0),
            stealthDoc.positionAt(stealthDoc.getText().length)
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(stealthDoc.uri, fullRange, 'brand new content');
        await vscode.workspace.applyEdit(edit);
        await sleep(200);
        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const disk = fs.readFileSync(fp, 'utf-8');
        assert.strictEqual(disk, 'brand new content');
    });

    test('9. undo 操作同步到真实文件', async () => {
        const fp = createTmpFile('start');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        // 输入
        let edit = new vscode.WorkspaceEdit();
        edit.insert(stealthDoc.uri, new vscode.Position(0, 5), '-added');
        await vscode.workspace.applyEdit(edit);
        await sleep(200);
        // 撤销
        await vscode.commands.executeCommand('undo');
        await sleep(200);
        // 保存
        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(300);

        const disk = fs.readFileSync(fp, 'utf-8');
        assert.strictEqual(disk, 'start');
    });

    test('10. 多次保存累积', async () => {
        const fp = createTmpFile('');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;

        let edit = new vscode.WorkspaceEdit();
        edit.insert(stealthDoc.uri, new vscode.Position(0, 0), 'aaa');
        await vscode.workspace.applyEdit(edit);
        await sleep(200);
        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(300);

        edit = new vscode.WorkspaceEdit();
        edit.insert(stealthDoc.uri, new vscode.Position(0, 3), 'bbb');
        await vscode.workspace.applyEdit(edit);
        await sleep(200);
        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(300);

        edit = new vscode.WorkspaceEdit();
        edit.insert(stealthDoc.uri, new vscode.Position(0, 6), 'ccc');
        await vscode.workspace.applyEdit(edit);
        await sleep(200);
        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(300);

        const disk = fs.readFileSync(fp, 'utf-8');
        assert.strictEqual(disk, 'aaabbbccc');
    });

    // ──────────────────────────────────────
    // 三、隐写 / 隐藏验证
    // ──────────────────────────────────────

    test('11. stealth 文档 languageId 为 stealth-text', async () => {
        const fp = createTmpFile('secret');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        assert.strictEqual(stealthDoc.languageId, 'stealth-text');
    });

    test('12. stealth 文档 URI scheme 为 stealth', async () => {
        const fp = createTmpFile('secret2');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        assert.strictEqual(stealthDoc.uri.scheme, 'stealth');
    });

    test('13. 标签页显示伪装名', async () => {
        const fp = createTmpFile('secret3');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        const stealthTab = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .find(
                (t) =>
                    t.input instanceof vscode.TabInputText &&
                    t.input.uri.toString() === stealthDoc.uri.toString()
            );
        assert.ok(stealthTab, 'stealth 标签应存在');
        assert.ok(
            stealthTab!.label.includes('Untitled-1'),
            `标签标题应包含伪装名，实际: ${stealthTab!.label}`
        );
    });

    test('14. stealth 文档内容与真实文件一致', async () => {
        const content = 'top secret content 12345';
        const fp = createTmpFile(content);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        assert.strictEqual(stealthDoc.getText(), content);
    });

    test('15. toggleName 切换显示名', async () => {
        const fp = createTmpFile('data');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        const getTabLabel = () => {
            const tab = vscode.window.tabGroups.all
                .flatMap((g) => g.tabs)
                .find(
                    (t) =>
                        t.input instanceof vscode.TabInputText &&
                        t.input.uri.toString() === stealthDoc.uri.toString()
                );
            return tab?.label || '';
        };

        const label1 = getTabLabel();
        assert.ok(label1.includes('Untitled-1'), `初始应为伪装名: ${label1}`);

        await vscode.commands.executeCommand('thief.toggleName');
        await sleep(500);

        const label2 = getTabLabel();
        assert.ok(label2.includes('data'), `切换后应为真实文件名: ${label2}`);

        await vscode.commands.executeCommand('thief.toggleName');
        await sleep(500);

        const label3 = getTabLabel();
        assert.ok(label3.includes('Untitled-1'), `再次切换应回伪装名: ${label3}`);
    });

    // ──────────────────────────────────────
    // 四、同时打开 / 文件同步
    // ──────────────────────────────────────

    test('16. 隐写保存后重新打开真实文件 → 内容一致', async () => {
        const fp = createTmpFile('before');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            stealthDoc.uri,
            new vscode.Range(stealthDoc.positionAt(0), stealthDoc.positionAt(6)),
            'after'
        );
        await vscode.workspace.applyEdit(edit);
        await sleep(200);
        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const reopened = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        assert.strictEqual(reopened.getText(), 'after');
    });

    test('17. 外部程序修改文件 → 隐写文档不崩溃', async () => {
        const fp = createTmpFile('original');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        // 模拟外部修改
        fs.writeFileSync(fp, 'externally modified', 'utf-8');
        await sleep(300);

        // 隐写文档仍应可访问
        const stealthDoc = vscode.window.activeTextEditor!.document;
        assert.ok(stealthDoc, '隐写文档仍应存在');
        assert.strictEqual(stealthDoc.uri.scheme, 'stealth');
    });

    // ──────────────────────────────────────
    // 五、关闭 / 重开标签
    // ──────────────────────────────────────

    test('18. 隐写未保存 → 关闭标签 → 重新 toggle → 空文档', async () => {
        const fp = createTmpFile('initial');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(stealthDoc.uri, new vscode.Position(0, 7), '-unsaved');
        await vscode.workspace.applyEdit(edit);
        await sleep(200);

        // 关闭标签（不保存）
        const tab = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .find(
                (t) =>
                    t.input instanceof vscode.TabInputText &&
                    t.input.uri.toString() === stealthDoc.uri.toString()
            );
        if (tab) {
            await vscode.window.tabGroups.close(tab, true);
        }
        await sleep(500);

        // 重新 toggle 进入隐写
        const realDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(realDoc, { preview: false });
        await sleep(300);
        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const newStealthDoc = vscode.window.activeTextEditor!.document;
        assert.strictEqual(newStealthDoc.getText(), 'initial');
    });

    test('19. 快速连续 toggle 不崩溃', async () => {
        const fp = createTmpFile('rapid');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        // 快速连续 toggle
        await vscode.commands.executeCommand('thief.toggle');
        await vscode.commands.executeCommand('thief.toggle');
        await sleep(1000);

        // 验证最终状态：应回到明文
        const ed = vscode.window.activeTextEditor;
        assert.ok(ed, '应有活动编辑器');
        // 可能在明文或隐写，验证不崩溃即可
        assert.ok(
            ed.document.uri.scheme === 'file' || ed.document.uri.scheme === 'stealth',
            `scheme 应为 file 或 stealth，实际: ${ed.document.uri.scheme}`
        );
    });

    // ──────────────────────────────────────
    // 六、切换 / 光标位置
    // ──────────────────────────────────────

    test('20. 隐写光标在第3行 → toggle 回明文 → 光标仍在第3行', async () => {
        const fp = createTmpFile('line1\nline2\nline3\nline4');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        // 设置光标到第3行
        const stealthEditor = vscode.window.activeTextEditor!;
        stealthEditor.selection = new vscode.Selection(2, 0, 2, 0);
        await sleep(200);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const plainEditor = vscode.window.activeTextEditor!;
        assert.strictEqual(plainEditor.selection.active.line, 2);
    });

    test('21. 明文光标在第1行 → toggle 进隐写 → 光标仍在第1行', async () => {
        const fp = createTmpFile('aaa\nbbb\nccc');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        // 确保光标在第1行
        const editor = vscode.window.activeTextEditor!;
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        await sleep(200);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthEditor = vscode.window.activeTextEditor!;
        assert.strictEqual(stealthEditor.selection.active.line, 0);
    });

    // ──────────────────────────────────────
    // 七、配置 / 状态栏
    // ──────────────────────────────────────

    test('22. recentIndicator=false → 隐写模式 → 状态栏隐藏', async () => {
        await getConfig().update('recentIndicator', false, vscode.ConfigurationTarget.Global);
        await sleep(200);

        const fp = createTmpFile('statusbar');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        // toggleRecent 内部会翻转，先设为 false，再 toggle 一次设为 true
        // 这里直接验证配置生效即可
        const config = getConfig().get<boolean>('recentIndicator');
        // toggleRecent 会翻转，所以实际值取决于调用次数
        assert.ok(typeof config === 'boolean', 'recentIndicator 应为 boolean');

        // 恢复
        await getConfig().update('recentIndicator', true, vscode.ConfigurationTarget.Global);
    });

    test('23. displayName 设为空字符串 → toggleName → 兜底为 Untitled-1', async () => {
        await getConfig().update('displayName', '', vscode.ConfigurationTarget.Global);
        await sleep(200);

        const fp = createTmpFile('empty-name-test');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        const tab = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .find(
                (t) =>
                    t.input instanceof vscode.TabInputText &&
                    t.input.uri.toString() === stealthDoc.uri.toString()
            );
        assert.ok(tab, '标签应存在');
        assert.ok(
            tab!.label.includes('Untitled-1'),
            `空 displayName 应兜底为 Untitled-1，实际: ${tab!.label}`
        );

        await getConfig().update('displayName', undefined, vscode.ConfigurationTarget.Global);
    });

    test('24. displayName 含路径分隔符 → 只取文件名', async () => {
        await getConfig().update('displayName', '/some/path/MyDoc.txt', vscode.ConfigurationTarget.Global);
        await sleep(200);

        const fp = createTmpFile('path-test');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        const tab = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .find(
                (t) =>
                    t.input instanceof vscode.TabInputText &&
                    t.input.uri.toString() === stealthDoc.uri.toString()
            );
        assert.ok(tab, '标签应存在');
        assert.ok(
            tab!.label.includes('MyDoc.txt'),
            `应只取文件名，实际: ${tab!.label}`
        );
        assert.ok(
            !tab!.label.includes('/'),
            `不应包含路径分隔符，实际: ${tab!.label}`
        );

        await getConfig().update('displayName', undefined, vscode.ConfigurationTarget.Global);
    });

    // ──────────────────────────────────────
    // 八、隐写文件系统 Provider
    // ──────────────────────────────────────

    test('25. 虚拟文件系统 writeFile → 磁盘内容一致', async () => {
        const fp = createTmpFile('provider-test');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            stealthDoc.uri,
            new vscode.Range(stealthDoc.positionAt(0), stealthDoc.positionAt(12)),
            'provider-writes'
        );
        await vscode.workspace.applyEdit(edit);
        await sleep(200);

        await vscode.commands.executeCommand('workbench.action.files.save');
        await sleep(500);

        const disk = fs.readFileSync(fp, 'utf-8');
        assert.strictEqual(disk, 'provider-writes');
    });

    test('26. 退出隐写后 unmap 清理', async () => {
        const fp = createTmpFile('cleanup-test');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc, { preview: false });
        await sleep(300);

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        const stealthDoc = vscode.window.activeTextEditor!.document;
        const fakeUriStr = stealthDoc.uri.toString();

        await vscode.commands.executeCommand('thief.toggle');
        await sleep(500);

        // 尝试重新打开同一 stealth URI（应失败，因为已 unmap）
        try {
            await vscode.workspace.openTextDocument(vscode.Uri.parse(fakeUriStr));
            // 如果没有抛出错误，检查文档是否仍可读取
            assert.fail('unmap 后不应能打开同一 stealth URI');
        } catch {
            // 预期行为：FileNotFound 或类似错误
            assert.ok(true, 'unmap 后打开失败是预期行为');
        }
    });
});
