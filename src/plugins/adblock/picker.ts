/**
 * 元素框选器脚本(纯字符串,无 electron / DOM 类型依赖)。
 *
 * PICKER_JS 由主进程通过 ctx.pages.execute 注入页面主世界:
 * - 在 Shadow DOM 中渲染高亮框 + 底部工具条(采用 constructed stylesheet,规避页面 CSP);
 * - 悬停高亮、点击选中、父/子级切换、选择器可编辑、实时预览、Esc 取消、Enter 确认;
 * - Promise 解析为 { selector, tag } 或 { cancelled: true }。
 *
 * PICKER_TEARDOWN_JS 用于取消(切标签/导航/超时):触发页内脚本 resolved cancelled。
 *
 * 注意:脚本内不使用反引号与 ${ 插值,整体以 String.raw 保留反斜杠。
 */

export const PICKER_JS: string = String.raw`(function () {
  'use strict';
  var W = window;
  if (W.__bowAdblockPicker && typeof W.__bowAdblockPicker.stop === 'function') {
    try { W.__bowAdblockPicker.stop(); } catch (e) {}
  }
  return new Promise(function (resolve) {
    var done = false;
    var current = null;
    var selected = null;
    var candidates = [];
    var candidateIdx = 0;
    var previewOn = true;
    var previewSheet = null;
    var HOST_ID = '__bow-adblock-picker-host';

    var CSS_TEXT = ':host{all:initial}' +
      '.box{position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid #e5484d;background:rgba(229,72,77,0.12);z-index:1}' +
      '.badge{position:fixed;pointer-events:none;background:#e5484d;color:#fff;font:11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:2px 6px;border-radius:4px;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;z-index:2}' +
      '.bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);pointer-events:auto;display:flex;gap:6px;align-items:center;background:#1e1f24;color:#e6e6e6;border:1px solid #3a3d44;border-radius:8px;padding:6px 8px;box-shadow:0 8px 24px rgba(0,0,0,0.4);font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;z-index:3;max-width:92vw}' +
      '.pinput{flex:1 1 260px;min-width:160px;background:#14151a;color:#e6e6e6;border:1px solid #3a3d44;border-radius:6px;padding:4px 8px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}' +
      '.pbtn{background:#2a2d34;color:#e6e6e6;border:1px solid #3a3d44;border-radius:6px;padding:4px 8px;font:12px/1.4 inherit;cursor:pointer;white-space:nowrap}' +
      '.pbtn:hover{background:#343841}' +
      '.pbtn.on{background:#3b5bdb;border-color:#3b5bdb;color:#fff}' +
      '.pbtn.danger{background:#e5484d;border-color:#e5484d;color:#fff}' +
      '.ptip{position:fixed;left:50%;bottom:66px;transform:translateX(-50%);background:#1e1f24;color:#ffd7d8;border:1px solid #e5484d;border-radius:6px;padding:4px 10px;font:12px/1.4 -apple-system,sans-serif;pointer-events:none;display:none;z-index:4}';

    var host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;';
    var root;
    try {
      root = host.attachShadow({ mode: 'open' });
    } catch (e) {
      root = host;
    }

    function attachStyles(shadow) {
      try {
        if (typeof CSSStyleSheet === 'function') {
          var sheet = new CSSStyleSheet();
          sheet.replaceSync(CSS_TEXT);
          shadow.adoptedStyleSheets = [sheet];
          return;
        }
      } catch (e) {}
      var style = document.createElement('style');
      style.textContent = CSS_TEXT;
      shadow.appendChild(style);
    }

    function make(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function makeButton(label, fn, cls) {
      var b = make('button', 'pbtn' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        fn();
      });
      return b;
    }

    var box = make('div', 'box');
    var badge = make('div', 'badge');
    var tip = make('div', 'ptip');
    var bar = make('div', 'bar');
    var input = make('input', 'pinput');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = 'CSS 选择器';

    var previewBtn = makeButton('预览:开', function () {
      previewOn = !previewOn;
      previewBtn.textContent = previewOn ? '预览:开' : '预览:关';
      previewBtn.className = 'pbtn' + (previewOn ? ' on' : '');
      applyPreview(input.value.trim());
    }, 'on');

    bar.appendChild(input);
    bar.appendChild(makeButton('父级', function () { moveTo(selected ? selected.parentElement : (current && current.parentElement)); }));
    bar.appendChild(makeButton('子级', function () {
      var t = selected || current;
      if (t && t.firstElementChild) moveTo(t.firstElementChild);
    }));
    bar.appendChild(makeButton('宽泛', function () { shiftCandidate(1); }));
    bar.appendChild(makeButton('精确', function () { shiftCandidate(-1); }));
    bar.appendChild(previewBtn);
    bar.appendChild(makeButton('屏蔽', function () { confirmPick(); }, 'danger'));
    bar.appendChild(makeButton('取消', function () { finish({ cancelled: true }); }));

    root.appendChild(box);
    root.appendChild(badge);
    root.appendChild(tip);
    root.appendChild(bar);
    attachStyles(root);
    document.documentElement.appendChild(host);

    W.__bowAdblockPicker = {
      stop: function () {
        finish({ cancelled: true });
      }
    };

    function finish(result) {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    }

    function cleanup() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mousedown', onSuppress, true);
      document.removeEventListener('mouseup', onSuppress, true);
      W.removeEventListener('keydown', onKey, true);
      W.removeEventListener('scroll', onScroll, true);
      W.removeEventListener('resize', onScroll, true);
      removePreview();
      if (host.parentNode) host.parentNode.removeChild(host);
      try { delete W.__bowAdblockPicker; } catch (e) { W.__bowAdblockPicker = undefined; }
    }

    function isHudEvent(e) {
      if (!e) return false;
      if (e.target === host) return true;
      if (typeof e.composedPath === 'function') return e.composedPath().indexOf(host) >= 0;
      return false;
    }

    function onSuppress(e) {
      if (isHudEvent(e)) return;
      e.preventDefault();
      e.stopPropagation();
    }

    function onMove(e) {
      if (selected) return;
      if (isHudEvent(e)) return;
      var t = e.target;
      if (!t || t.nodeType !== 1 || t === host) return;
      setCurrent(t);
    }

    function onClick(e) {
      if (isHudEvent(e)) return;
      e.preventDefault();
      e.stopPropagation();
      var t = e.target;
      if (!t || t.nodeType !== 1 || t === host) return;
      moveTo(t);
    }

    function onKey(e) {
      if (e.target === input) {
        if (e.key === 'Escape') { e.preventDefault(); finish({ cancelled: true }); }
        else if (e.key === 'Enter') { e.preventDefault(); confirmPick(); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish({ cancelled: true }); return; }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirmPick(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveTo(selected ? selected.parentElement : (current && current.parentElement)); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        var t = selected || current;
        if (t && t.firstElementChild) moveTo(t.firstElementChild);
        return;
      }
    }

    function onScroll() {
      updateBox();
    }

    function setCurrent(el) {
      current = el;
      candidates = selectorCandidates(el);
      candidateIdx = 0;
      input.value = candidates[0] || '';
      updateBox();
      applyPreview(input.value.trim());
    }

    function moveTo(el) {
      if (!el || el.nodeType !== 1) return;
      selected = el;
      candidates = selectorCandidates(el);
      candidateIdx = 0;
      input.value = candidates[0] || '';
      updateBox();
      applyPreview(input.value.trim());
    }

    function shiftCandidate(delta) {
      if (!candidates.length) return;
      candidateIdx = Math.max(0, Math.min(candidates.length - 1, candidateIdx + delta));
      input.value = candidates[candidateIdx];
      applyPreview(input.value.trim());
    }

    function updateBox() {
      var el = selected || current;
      if (!el || !el.getBoundingClientRect) {
        box.style.display = 'none';
        badge.style.display = 'none';
        return;
      }
      var r = el.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = Math.max(0, r.width) + 'px';
      box.style.height = Math.max(0, r.height) + 'px';
      badge.style.display = 'block';
      var label = el.tagName ? el.tagName.toLowerCase() : '?';
      if (el.id) label += '#' + el.id;
      badge.textContent = label + ' · ' + Math.round(r.width) + '×' + Math.round(r.height);
      badge.style.left = Math.max(0, r.left) + 'px';
      badge.style.top = Math.max(0, r.top - 22) + 'px';
    }

    function flash(msg) {
      tip.textContent = msg;
      tip.style.display = 'block';
      W.setTimeout(function () { tip.style.display = 'none'; }, 2200);
    }

    function confirmPick() {
      var sel = input.value.trim();
      if (!sel) { flash('请输入选择器'); return; }
      try {
        document.querySelector(sel);
      } catch (e) {
        flash('选择器无效:' + sel);
        return;
      }
      var el = selected || current;
      finish({ selector: sel, tag: el && el.tagName ? el.tagName.toLowerCase() : '' });
    }

    function cssEscape(v) {
      if (W.CSS && typeof W.CSS.escape === 'function') return W.CSS.escape(v);
      return String(v).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
    }

    function unique(sel) {
      try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
    }

    function tooBroad(sel, el) {
      if (el === document.documentElement || el === document.body) return false;
      try {
        var found = document.querySelectorAll(sel);
        if (found.length !== 1) return true;
        return found[0] === document.documentElement || found[0] === document.body;
      } catch (e) {
        return true;
      }
    }

    function usable(sel, el) {
      return !!sel && unique(sel) && !tooBroad(sel, el);
    }

    function stableClasses(el) {
      var out = [];
      var list = el.classList ? Array.prototype.slice.call(el.classList) : [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || c.length > 40) continue;
        if (/^(is-|has-|js-|active$|selected$|open$|hover$|focus$|show$|hidden$|visible$)/.test(c)) continue;
        if (/[0-9a-f]{6,}/i.test(c)) continue;
        if (/\d{3,}/.test(c)) continue;
        out.push(c);
      }
      return out;
    }

    function pathSelector(el) {
      var parts = [];
      var cur = el;
      var depth = 0;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < 6) {
        var tag = cur.tagName.toLowerCase();
        var parent = cur.parentElement;
        if (!parent) { parts.unshift(tag); break; }
        var peers = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
        var idx = peers.indexOf(cur) + 1;
        parts.unshift(peers.length > 1 ? tag + ':nth-of-type(' + idx + ')' : tag);
        cur = parent;
        depth++;
      }
      return parts.join(' > ');
    }

    function selectorCandidates(el) {
      var out = [];
      var tag = el.tagName ? el.tagName.toLowerCase() : 'div';
      if (el.id) {
        var idSel = '#' + cssEscape(el.id);
        if (usable(idSel, el)) out.push(idSel);
      }
      var attrs = ['data-testid', 'data-test', 'data-qa', 'data-ad', 'data-ad-slot', 'aria-label'];
      for (var i = 0; i < attrs.length; i++) {
        var v = el.getAttribute ? el.getAttribute(attrs[i]) : null;
        if (!v || v.length > 60) continue;
        var aSel = tag + '[' + attrs[i] + '="' + String(v).replace(/"/g, '\\"') + '"]';
        if (usable(aSel, el) && out.indexOf(aSel) < 0) out.push(aSel);
      }
      var classes = stableClasses(el);
      if (classes.length) {
        var cSel = tag + '.' + classes.map(cssEscape).join('.');
        if (usable(cSel, el) && out.indexOf(cSel) < 0) out.push(cSel);
        for (var j = 0; j < classes.length; j++) {
          var one = tag + '.' + cssEscape(classes[j]);
          if (usable(one, el) && out.indexOf(one) < 0) out.push(one);
        }
      }
      var path = pathSelector(el);
      if (path && usable(path, el) && out.indexOf(path) < 0) out.push(path);
      if (!out.length) out.push(tag);
      return out;
    }

    function ensurePreviewSheet() {
      if (previewSheet) return previewSheet;
      try {
        if (typeof CSSStyleSheet === 'function') {
          previewSheet = new CSSStyleSheet();
          var arr = (document.adoptedStyleSheets || []).slice();
          arr.push(previewSheet);
          document.adoptedStyleSheets = arr;
        }
      } catch (e) {
        previewSheet = null;
      }
      return previewSheet;
    }

    function applyPreview(sel) {
      if (!previewOn || !sel) { removePreview(); return; }
      var sheet = ensurePreviewSheet();
      if (!sheet) return;
      try {
        sheet.replaceSync(sel + '{visibility:hidden!important}');
      } catch (e) {
        try { sheet.replaceSync(''); } catch (e2) {}
      }
    }

    function removePreview() {
      if (!previewSheet) return;
      try {
        document.adoptedStyleSheets = (document.adoptedStyleSheets || []).filter(function (s) { return s !== previewSheet; });
      } catch (e) {}
      previewSheet = null;
    }

    input.addEventListener('input', function () { applyPreview(input.value.trim()); });

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', onSuppress, true);
    document.addEventListener('mouseup', onSuppress, true);
    W.addEventListener('keydown', onKey, true);
    W.addEventListener('scroll', onScroll, true);
    W.addEventListener('resize', onScroll, true);
    try { input.focus(); } catch (e) {}
  });
})()`

/** 取消当前框选(切标签 / 导航 / 超时) */
export const PICKER_TEARDOWN_JS = String.raw`(function () {
  try {
    if (window.__bowAdblockPicker && typeof window.__bowAdblockPicker.stop === 'function') {
      window.__bowAdblockPicker.stop();
    }
  } catch (e) {}
})()`
