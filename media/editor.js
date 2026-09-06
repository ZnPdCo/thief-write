/* Thief Write 的 webview 端逻辑 */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const C = window.SessionCore;

    const doc = document.getElementById('doc');
    const recentEl = document.getElementById('recent');

    let state = C.createState();
    let maskMode = true; // 没有伪装源文本时，按真实字符宽度打码显示
    let pool = [];
    let lastDecoy = '';
    let composing = false;
    let compStart = 0;
    let compEnd = 0;
    let inputCommitted = false; // input 兜底已处理本次组合提交，compositionend 别再重复
    let applying = false; // 我们自己写 value 时的开关
    let recentOn = true;

    function makeDisplay() {
        return maskMode ? C.renderMask(state) : C.render(state, pool);
    }

    function caretIndex() {
        return doc.selectionStart || 0;
    }

    function setSelection(i) {
        try {
            doc.focus();
            doc.setSelectionRange(i, i);
        } catch (err) {}
    }

    function applyDisplay(caret) {
        const display = makeDisplay();
        lastDecoy = display;
        const st = doc.scrollTop;
        const sl = doc.scrollLeft;
        applying = true;
        doc.value = display;
        doc.scrollTop = st;
        doc.scrollLeft = sl;
        setSelection(caret);
        applying = false;
        refreshRecent();
    }

    // 右下角提示：光标两侧的真实字符，随光标和输入实时刷新
    function fmtChar(c) {
        if (c === '\n' || c === '\r') {
            return '⏎';
        }
        return c;
    }

    function refreshRecent() {
        if (!recentEl) {
            return;
        }
        if (!recentOn) {
            recentEl.hidden = true;
            return;
        }
        const cpsArr = state.cps;
        const i = composing ? compStart : caretIndex();
        const left = i > 0 ? fmtChar(cpsArr[i - 1]) : '';
        const right = i < cpsArr.length ? fmtChar(cpsArr[i]) : '';
        recentEl.textContent = left + '|' + right;
        recentEl.hidden = false;
    }

    document.addEventListener('selectionchange', function () {
        refreshRecent();
    });

    function sendOps(ops) {
        if (ops && ops.length) {
            vscode.postMessage({ type: 'ops', ops: ops });
        }
    }

    // 把会话区间 [s, e) 替换成真实文本 text，并上报宿主
    function doApplyAt(s, e, text) {
        const ops = [];
        if (e > s) {
            C.deleteRange(state, s, e);
            ops.push({ t: 'd', s: s, e: e });
        }
        let added = 0;
        if (text && text.length) {
            added = Array.from(text).length;
            C.insertText(state, s, text);
            ops.push({ t: 'i', s: s, text: text });
        }
        sendOps(ops);
        applyDisplay(s + added);
    }

    function commitPlain(text) {
        const s = doc.selectionStart || 0;
        const e = doc.selectionEnd || 0;
        doApplyAt(s, e, text);
    }

    function backspace() {
        let s = doc.selectionStart || 0;
        const e = doc.selectionEnd || 0;
        if (s === e) {
            if (s === 0) {
                return; // 再往前就是历史区，删不得
            }
            s = s - 1;
        }
        doApplyAt(s, e, '');
    }

    function isComposingEvent(e) {
        return e.isComposing === true || e.keyCode === 229;
    }

    doc.addEventListener('keydown', function (e) {
        const key = e.key;

        // 组合未结束时 Enter 由我们插入换行，否则输入法会把它报成 229 把换行吞掉
        if (key === 'Enter' && !composing && !e.isComposing) {
            e.preventDefault();
            commitPlain('\n');
            return;
        }
        if (isComposingEvent(e)) {
            return; // 组合中，交给输入法
        }

        // 只放行 Ctrl/Cmd+C（复制的是屏幕上的伪装文本，不泄密）
        if (e.ctrlKey || e.metaKey) {
            if (key.toLowerCase() === 'c') {
                return;
            }
            e.preventDefault();
            return;
        }

        if (key === 'Backspace') {
            e.preventDefault();
            backspace();
            return;
        }
        if (key === 'Delete') {
            e.preventDefault(); // 只做退格
            return;
        }
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
            if (e.shiftKey || e.altKey) {
                e.preventDefault();
                return;
            }
            return; // 原生的左右移动照常
        }
        if (
            key === 'ArrowUp' ||
            key === 'ArrowDown' ||
            key === 'Home' ||
            key === 'End' ||
            key === 'PageUp' ||
            key === 'PageDown'
        ) {
            e.preventDefault();
            return;
        }
        if (e.altKey) {
            e.preventDefault();
            return;
        }
        if (key.length === 1) {
            e.preventDefault();
            commitPlain(key);
            return;
        }
        e.preventDefault(); // Tab 等其余键一律拦掉
    });

    // 阻止浏览器自带的菜单、拖放等可能弄脏伪装文本的操作
    doc.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        return false;
    });
    doc.addEventListener('dragover', function (e) {
        e.preventDefault();
    });
    doc.addEventListener('drop', function (e) {
        e.preventDefault();
    });

    // 拼音组合期间让输入法自然显示，确认后整段换成伪装字符
    doc.addEventListener('compositionstart', function () {
        composing = true;
        inputCommitted = false;
        compStart = doc.selectionStart || 0;
        compEnd = doc.selectionEnd || 0;
    });

    doc.addEventListener('compositionend', function (e) {
        if (inputCommitted) {
            composing = false;
            inputCommitted = false;
            return;
        }
        composing = false;
        const text = e.data || '';
        if (!text) {
            reconcileInput(false); // 取消或没拿到 data，用前后差异收尾
            return;
        }
        doApplyAt(compStart, compEnd, text);
    });

    // 有些输入法不发 keydown/composition，直接改了 value，只能靠 diff 兜底
    function reconcileInput(wasComposing) {
        if (applying) {
            return;
        }
        const value = doc.value;
        if (value === lastDecoy) {
            return;
        }
        const d = C.singleEditDiff(lastDecoy, value);
        if (!d.text && d.e <= d.s) {
            applyDisplay(caretIndex()); // 纯取消，把显示恢复回来
            return;
        }
        if (wasComposing) {
            inputCommitted = true;
        }
        doApplyAt(d.s, d.e, d.text);
    }

    doc.addEventListener('input', function (e) {
        if (e && e.isComposing === true) {
            return; // 组合中的更新不用管
        }
        const wasComposing = composing;
        if (e && e.isComposing === false) {
            composing = false;
        }
        if (composing) {
            return; // 拿不准已结束，留给 compositionend
        }
        reconcileInput(wasComposing);
    });

    vscode.postMessage({ type: 'ready' });

    window.addEventListener('beforeunload', function () {
        vscode.postMessage({ type: 'flush' });
    });

    window.addEventListener('message', function (e) {
        const msg = e.data;
        if (!msg || !msg.command) {
            return;
        }
        if (msg.command === 'init' || msg.command === 'reset') {
            state = C.createState();
            C.loadSession(state, msg.sessionText || '');
            if (typeof msg.source === 'string') {
                setSource(msg.source);
            }
            if (typeof msg.recent === 'boolean') {
                recentOn = msg.recent;
            }
            applyDisplay(C.length(state));
        } else if (msg.command === 'recent') {
            if (typeof msg.recent === 'boolean') {
                recentOn = msg.recent;
                refreshRecent();
            }
        } else if (msg.command === 'source') {
            if (typeof msg.source === 'string') {
                setSource(msg.source);
                applyDisplay(caretIndex());
            }
        } else if (msg.command === 'focus') {
            doc.focus();
            setSelection(caretIndex());
        }
    });

    // 源文本为空 → 宽度打码；否则建伪装池逐字循环显示
    function setSource(text) {
        if (text) {
            maskMode = false;
            pool = C.buildPool(text);
        } else {
            maskMode = true;
            pool = [];
        }
    }

    applyDisplay(0);
})();
