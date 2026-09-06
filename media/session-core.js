(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SessionCore = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // 没有伪装源时的“打码”显示：全角字符用全角占位、半角字符用半角占位，
    // 让遮罩的排版宽度跟真实文本一致。这两个字符可随手换成别的。
    const MASK_FULL = '口';
    const MASK_HALF = '·';

    // 是不是占满一格的“宽字符”（汉字、日文、谚文、全角标点等）
    function isWideChar(ch) {
        const c = ch.codePointAt(0);
        return (
            (c >= 0x1100 && c <= 0x115f) ||
            (c >= 0x2e80 && c <= 0x303e) ||
            (c >= 0x3041 && c <= 0x33ff) ||
            (c >= 0x3400 && c <= 0x4dbf) ||
            (c >= 0x4e00 && c <= 0x9fff) ||
            (c >= 0xa000 && c <= 0xa4cf) ||
            (c >= 0xac00 && c <= 0xd7a3) ||
            (c >= 0xf900 && c <= 0xfaff) ||
            (c >= 0xfe10 && c <= 0xfe19) ||
            (c >= 0xfe30 && c <= 0xfe6f) ||
            (c >= 0xff00 && c <= 0xff60) ||
            (c >= 0xffe0 && c <= 0xffe6)
        );
    }

    function cps(s) {
        return typeof s === 'string' ? Array.from(s) : [];
    }

    function clamp(v, lo, hi) {
        return v < lo ? lo : v > hi ? hi : v;
    }

    function createState() {
        return { cps: [] };
    }

    function loadSession(state, text) {
        state.cps = cps(text);
    }

    function length(state) {
        return state.cps.length;
    }

    function insertText(state, i, text) {
        const arr = cps(text);
        if (!arr.length) {
            return;
        }
        const at = clamp(i, 0, state.cps.length);
        state.cps.splice(at, 0, ...arr);
    }

    function deleteRange(state, a, b) {
        const lo = clamp(a, 0, state.cps.length);
        const hi = clamp(b, lo, state.cps.length);
        if (hi > lo) {
            state.cps.splice(lo, hi - lo);
        }
    }

    function sessionText(state) {
        return state.cps.join('');
    }

    // 历史区（打开文件时已有的原文）在最前，本次会话内容接在后面
    function realContent(state, protectedText) {
        return (protectedText || '') + sessionText(state);
    }

    // 从伪装源挑出能用的字符：按码点逐字保留顺序，丢掉换行、代理对和不可见字符。
    // 源空或挑不出可见字符时退回单个全角占位，至少保证一码元一格。
    function buildPool(sourceText) {
        const src =
            typeof sourceText === 'string' && sourceText ? sourceText : MASK_FULL;
        let pool = [];
        const arr = Array.from(src);
        for (let i = 0; i < arr.length; i++) {
            const ch = arr[i];
            if (ch.length !== 1) {
                continue;
            }
            const code = ch.charCodeAt(0);
            if (code >= 0xd800 && code <= 0xdfff) {
                continue;
            }
            if (ch === '\n' || ch === '\r') {
                continue;
            }
            if (isInvisibleChar(ch)) {
                continue;
            }
            pool.push(ch);
        }
        if (!pool.length) {
            pool = [MASK_FULL];
        }
        return pool;
    }

    // BOM、零宽、组合附加符、变体选择符之类，显示出来会占格但看不见
    function isInvisibleChar(ch) {
        const code = ch.charCodeAt(0);
        if (code === 0xfeff) {
            return true;
        }
        if (code >= 0x200b && code <= 0x200f) {
            return true;
        }
        if (code >= 0x2060 && code <= 0x2064) {
            return true;
        }
        if (code >= 0x0300 && code <= 0x036f) {
            return true;
        }
        if (code >= 0xfe00 && code <= 0xfe0f) {
            return true;
        }
        return false;
    }

    // 逐格换成池里的伪装字符；真实换行照旧显示为换行
    function render(state, pool) {
        const out = [];
        const n = pool.length;
        for (let i = 0; i < state.cps.length; i++) {
            const ch = state.cps[i];
            out.push(ch === '\n' || ch === '\r' ? '\n' : pool[i % n]);
        }
        return out.join('');
    }

    // 打码显示：宽字符 → 全角占位，半角字符 → 半角占位，换行照旧
    function renderMask(state) {
        const out = [];
        for (let i = 0; i < state.cps.length; i++) {
            const ch = state.cps[i];
            if (ch === '\n' || ch === '\r') {
                out.push('\n');
            } else {
                out.push(isWideChar(ch) ? MASK_FULL : MASK_HALF);
            }
        }
        return out.join('');
    }

    // 相对旧文本的一次编辑：删 [s, e)，再在 s 处插 text。
    // 给 webview 兜底，处理只改 value、不发键盘/组合事件的输入法。
    function singleEditDiff(before, after) {
        if (before === after) {
            return { s: 0, e: 0, text: '' };
        }
        let p = 0;
        const maxP = Math.min(before.length, after.length);
        while (p < maxP && before[p] === after[p]) {
            p++;
        }
        let q = 0;
        while (
            p + q < Math.min(before.length, after.length) &&
            before[before.length - 1 - q] === after[after.length - 1 - q]
        ) {
            q++;
        }
        const e0 = before.length - q;
        const e1 = after.length - q;
        return { s: p, e: e0, text: after.slice(p, e1) };
    }

    return {
        MASK_FULL: MASK_FULL,
        MASK_HALF: MASK_HALF,
        createState: createState,
        loadSession: loadSession,
        length: length,
        insertText: insertText,
        deleteRange: deleteRange,
        sessionText: sessionText,
        realContent: realContent,
        buildPool: buildPool,
        render: render,
        renderMask: renderMask,
        singleEditDiff: singleEditDiff,
    };
});
