'use strict';
const assert = require('assert');
const path = require('path');
const C = require(path.join(__dirname, '..', 'media', 'session-core.js'));

function eq(actual, expected, msg) {
    assert.strictEqual(actual, expected, msg);
}

function newState(protectedText) {
    const s = C.createState();
    return { protectedText: protectedText || '', s };
}

function real(st) {
    return C.realContent(st.s, st.protectedText);
}

function display(st, pool) {
    // 没传池时按“无伪装源”处理：按真实字符宽度打码
    return pool ? C.render(st.s, pool) : C.renderMask(st.s);
}

// 1. 保护符区：打开文件后的全部历史绝不显示、绝不进入会话
{
    const st = newState('history line.\n');
    eq(real(st), 'history line.\n', '历史原样保留');
    eq(C.length(st.s), 0, '会话从空开始');
    eq(display(st), '', '显示从空开始（历史不显示）');
}

// 2. 中文候选整段提交
{
    const st = newState('H');
    C.insertText(st.s, 0, '你好世界');
    eq(real(st), 'H你好世界', '候选整段写入草稿(历史之后)');
    eq(C.length(st.s), 4, '4 个真实汉字');
}

// 3. 逐字拼音输入
{
    const st = newState();
    for (const ch of ['再', '来', '一', '个']) {
        C.insertText(st.s, C.length(st.s), ch);
    }
    eq(real(st), '再来一个', '逐字累积');
}

// 4. Backspace：删除会话末尾一个码点（= 一个真实字符）
{
    const st = newState();
    C.insertText(st.s, 0, '你好世界');
    C.deleteRange(st.s, C.length(st.s) - 1, C.length(st.s));
    eq(real(st), '你好世', '退格删最后一个字');
}

// 5. 中段插入
{
    const st = newState();
    C.insertText(st.s, 0, '你好世界');
    C.insertText(st.s, 2, '（插）');
    eq(real(st), '你好（插）世界', '中段插入');
}

// 6. 中段删除
{
    const st = newState();
    C.insertText(st.s, 0, '你好（插）世界');
    const i = st.s.cps.indexOf('世');
    C.deleteRange(st.s, i, i + 1);
    eq(real(st), '你好（插）界', '中段退格');
}

// 7. 保护：删除操作只会在会话内，历史区索引不可能出现
{
    const st = newState('protected');
    C.insertText(st.s, 0, 'AB');
    C.deleteRange(st.s, 0, 1);
    eq(real(st), 'protectedB', '只能删会话首字符 A');
    eq(real(st).startsWith('protected'), true, '历史毫发无损');
}

// 8. Enter：真实换行，伪装显示也换行
{
    const st = newState();
    C.insertText(st.s, 0, '第一行');
    C.insertText(st.s, C.length(st.s), '\n第二行');
    eq(real(st), '第一行\n第二行', '真实内容有换行');
    const d = display(st);
    eq(d.split('\n').length, 2, '伪装显示两行');
    eq(d.split('\n')[0].split('\n').length > 0, true, '首行非空');
}

// 9. 伪装渲染：长度与会话码点数一致，且不含真实字符
{
    const st = newState();
    const pool = C.buildPool('The quick brown fox.');
    C.insertText(st.s, 0, '这是秘密内容');
    const d = display(st, pool);
    eq(Array.from(d).length, 6, '每个真实码点对应一个伪装码点');
    eq(d.includes('秘'), false, '真实字符绝不出现');
    eq(d.includes('密'), false, '真实字符绝不出现(2)');
}

// 10. 伪装确定性：同一会话每次 render 结果一致（刷新可重建）
{
    const st = newState();
    const pool = C.buildPool('abc');
    C.insertText(st.s, 0, '你好');
    const d1 = display(st, pool);
    const s2 = C.createState();
    C.loadSession(s2, '你好');
    eq(C.render(s2, pool), d1, '从会话文本可确定性重建伪装');
    eq(d1, 'ab', '取模循环：index0->a index1->b');
}

// 11. 伪源含 emoji：池过滤为单码元字符，保证显示 1 码点=1 码元
{
    const pool = C.buildPool('A😀B');
    eq(pool.includes('😀'), false, '代理对字符被过滤');
    eq(pool.join(''), 'AB', '池为单码元字符');
}

// 11b. 伪装源以 BOM/零宽字符开头：不得顶掉第一个可见伪装字（偏一位回归测试）
{
    const pool = C.buildPool('\uFEFF青山依旧在');
    eq(pool.join('').charCodeAt(0) === 0xfeff, false, 'BOM 被过滤');
    eq(pool[0], '青', '第一个可见字应为“青”，不再偏一位');

    const pool2 = C.buildPool('\u200Bhello');
    eq(pool2[0], 'h', '零宽空格不占位');

    const pool3 = C.buildPool('\u0301abc'); // 开头组合音标
    eq(pool3[0], 'a', '组合附加符被过滤');
}

// 11c. 伪装池保留重复字与标点（不再“去重”，屏幕应按源文本逐字回放）
{
    const p = C.buildPool('，。！');
    eq(p.join(''), '，。！', '标点按顺序保留');

    const p2 = C.buildPool('你好你好，再见！');
    eq(p2.slice(0, 4).join(''), '你好你好', '重复的“你好”不再丢失');
    eq(p2.join('').includes('，'), true, '逗号保留');
    eq(p2.join('').includes('！'), true, '叹号保留');
}

// 11d. 没有伪装源：打码宽度跟随真实字符（全角=口，半角=·，中文标点算全角）
{
    eq(C.MASK_FULL, '口', '全角占位是口');
    eq(C.MASK_HALF, '·', '半角占位是·');

    const st = newState();
    C.insertText(st.s, 0, '你好ab');
    eq(C.renderMask(st.s), '口口··', '汉字用全角口、字母用半角·');
    eq(Array.from(C.renderMask(st.s)).length, 4, '打码码点数与会话一致');

    const st2 = newState();
    C.insertText(st2.s, 0, '你，A1。');
    eq(C.renderMask(st2.s), '口口··口', '中文标点算全角，数字字母算半角');
}

// 12. 单点差异 diff（webview 兜底捕获用）
{
    const d1 = C.singleEditDiff('abcd', 'abXcd');
    eq(d1.s, 2);
    eq(d1.e, 2);
    eq(d1.text, 'X');

    const d2 = C.singleEditDiff('abcd', 'abc');
    eq(d2.s, 3);
    eq(d2.e, 4);
    eq(d2.text, '');

    const d3 = C.singleEditDiff('abc', 'abcc');
    eq(d3.text, 'c'); // 追加在结尾，不被后缀误判成替换

    const d4 = C.singleEditDiff('ab', 'abb');
    eq(d4.s, 2);
    eq(d4.text, 'b'); // 重叠边界 clamp 正确
}

// 13. 大输入稳定性
{
    const st = newState();
    for (let i = 0; i < 2000; i++) {
        C.insertText(st.s, C.length(st.s), '好');
    }
    eq(C.length(st.s), 2000, '大量输入');
    eq(Array.from(display(st)).length, 2000, '伪装与真实等长');
}

console.log('session-core.test: ALL PASS');
