/**
 * 元素全屏插件注入脚本(纯字符串,无 electron / DOM 类型依赖)。
 *
 * 三个脚本均由主进程经 ctx.pages.execute 注入页面主世界:
 * - PICK_JS:在 Shadow DOM 中渲染高亮框 + 徽标 + 提示条,悬停高亮、点击选中、
 *   ↑/↓ 切换父/子级、Esc 取消;Promise 解析为 { selector, tag } 或 { cancelled: true };
 * - PICK_TEARDOWN_JS:取消进行中的框选(切标签/导航/超时);
 * - buildApplyScript(selector):让首个匹配元素原地铺满网页视口(背景层 + 祖先
 *   containing block 中和 + 页面滚动锁定 + Esc 还原),返回 { ok, selector, tag, count };
 * - RESTORE_JS:还原当前页面的元素全屏(幂等)。
 *
 * 注意:脚本内不使用反引号与 ${ 插值,整体以 String.raw 保留反斜杠;
 * 选择器通过 JSON.stringify 安全内联,避免引号/反斜杠注入。
 */

/** 页面侧全屏运行时句柄 */
export const FS_GLOBAL = '__bowElementFullscreen'
/** 页面侧框选器句柄 */
export const PICKER_GLOBAL = '__bowElementFullscreenPicker'

export const PICK_JS: string = String.raw`(function () {
  'use strict';
  var W = window;
  if (W.__bowElementFullscreenPicker && typeof W.__bowElementFullscreenPicker.stop === 'function') {
    try { W.__bowElementFullscreenPicker.stop(); } catch (e) {}
  }
  return new Promise(function (resolve) {
    var done = false;
    var current = null;
    var HOST_ID = '__bow-element-fullscreen-picker-host';
    var HINT_TEXT = '点击选择元素 · ↑ 父级 · ↓ 子级 · Esc 取消';

    var CSS_TEXT = ':host{all:initial}' +
      '.box{position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid #3b82f6;background:rgba(59,130,246,0.18);z-index:1}' +
      '.badge{position:fixed;pointer-events:none;background:#3b82f6;color:#fff;font:11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:2px 6px;border-radius:4px;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;z-index:2}' +
      '.hint{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);background:#1e1f24;color:#e6e6e6;border:1px solid #3a3d44;border-radius:8px;padding:6px 12px;box-shadow:0 8px 24px rgba(0,0,0,0.4);font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;z-index:3;white-space:nowrap}';

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

    var box = make('div', 'box');
    var badge = make('div', 'badge');
    var hint = make('div', 'hint', HINT_TEXT);
    root.appendChild(box);
    root.appendChild(badge);
    root.appendChild(hint);
    attachStyles(root);
    document.documentElement.appendChild(host);

    W.__bowElementFullscreenPicker = {
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
      if (host.parentNode) host.parentNode.removeChild(host);
      try { delete W.__bowElementFullscreenPicker; } catch (e) { W.__bowElementFullscreenPicker = undefined; }
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
      if (isHudEvent(e)) return;
      var t = e.target;
      if (!t || t.nodeType !== 1 || t === host) return;
      moveTo(t);
    }

    function onClick(e) {
      if (isHudEvent(e)) return;
      e.preventDefault();
      e.stopPropagation();
      var t = e.target;
      if (!t || t.nodeType !== 1 || t === host) return;
      moveTo(t);
      confirmPick();
    }

    function onKey(e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        finish({ cancelled: true });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        moveTo(current && current.parentElement);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        if (current && current.firstElementChild) moveTo(current.firstElementChild);
        return;
      }
    }

    function onScroll() {
      updateBox();
    }

    function moveTo(el) {
      if (!el || el.nodeType !== 1) return;
      current = el;
      updateBox();
    }

    function updateBox() {
      if (!current || !current.getBoundingClientRect) {
        box.style.display = 'none';
        badge.style.display = 'none';
        return;
      }
      var r = current.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = Math.max(0, r.width) + 'px';
      box.style.height = Math.max(0, r.height) + 'px';
      badge.style.display = 'block';
      var label = current.tagName ? current.tagName.toLowerCase() : '?';
      if (current.id) label += '#' + current.id;
      badge.textContent = label + ' · ' + Math.round(r.width) + '×' + Math.round(r.height);
      badge.style.left = Math.max(0, r.left) + 'px';
      badge.style.top = Math.max(0, r.top - 22) + 'px';
    }

    function flash(msg) {
      hint.textContent = msg;
      W.setTimeout(function () {
        if (!done) hint.textContent = HINT_TEXT;
      }, 2000);
    }

    function confirmPick() {
      if (!current) return;
      if (current === document.documentElement || current === document.body) {
        flash('不能全屏整个页面');
        return;
      }
      var selector = selectorCandidates(current)[0];
      if (!selector) {
        flash('无法生成有效选择器');
        return;
      }
      finish({ selector: selector, tag: current.tagName ? current.tagName.toLowerCase() : '' });
    }

    function cssEscape(v) {
      if (W.CSS && typeof W.CSS.escape === 'function') return W.CSS.escape(v);
      return String(v).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
    }

    function unique(sel) {
      try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
    }

    function usable(sel) {
      return !!sel && unique(sel);
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
        if (usable(idSel)) out.push(idSel);
      }
      var attrs = ['data-testid', 'data-test', 'data-qa', 'aria-label'];
      for (var i = 0; i < attrs.length; i++) {
        var v = el.getAttribute ? el.getAttribute(attrs[i]) : null;
        if (!v || v.length > 60) continue;
        var aSel = tag + '[' + attrs[i] + '="' + String(v).replace(/"/g, '\\"') + '"]';
        if (usable(aSel) && out.indexOf(aSel) < 0) out.push(aSel);
      }
      var classes = stableClasses(el);
      if (classes.length) {
        var cSel = tag + '.' + classes.map(cssEscape).join('.');
        if (usable(cSel) && out.indexOf(cSel) < 0) out.push(cSel);
        for (var j = 0; j < classes.length; j++) {
          var one = tag + '.' + cssEscape(classes[j]);
          if (usable(one) && out.indexOf(one) < 0) out.push(one);
        }
      }
      var path = pathSelector(el);
      if (path && usable(path) && out.indexOf(path) < 0) out.push(path);
      if (!out.length) out.push(tag);
      return out;
    }

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', onSuppress, true);
    document.addEventListener('mouseup', onSuppress, true);
    W.addEventListener('keydown', onKey, true);
    W.addEventListener('scroll', onScroll, true);
    W.addEventListener('resize', onScroll, true);
  });
})()`

/** 取消当前框选(切标签 / 导航 / 超时) */
export const PICK_TEARDOWN_JS: string = String.raw`(function () {
  try {
    if (window.__bowElementFullscreenPicker && typeof window.__bowElementFullscreenPicker.stop === 'function') {
      window.__bowElementFullscreenPicker.stop();
    }
  } catch (e) {}
})()`

/**
 * 还原当前页面的元素全屏(幂等):页面已刷新/未全屏时安全返回。
 */
export const RESTORE_JS: string = String.raw`(function () {
  'use strict';
  var ns = window.__bowElementFullscreen;
  if (!ns || typeof ns.restore !== 'function') return { ok: true, restored: false };
  try {
    ns.restore();
  } catch (e) {}
  return { ok: true, restored: true };
})()`

const APPLY_JS_PREFIX: string = String.raw`(function () {
  'use strict';
  var SEL = `

const APPLY_JS_SUFFIX: string = String.raw`;
  var NS_KEY = '__bowElementFullscreen';
  var prev = window[NS_KEY];
  if (prev && typeof prev.restore === 'function') {
    try { prev.restore(); } catch (e) {}
  }
  var list = null;
  var el = null;
  try {
    list = document.querySelectorAll(SEL);
    el = list[0] || null;
  } catch (e) {
    return { ok: false, error: '选择器无效: ' + SEL };
  }
  if (!el) return { ok: false, error: '未找到元素: ' + SEL };
  if (el === document.documentElement || el === document.body) {
    return { ok: false, error: '不能全屏整个页面' };
  }

  var saved = [];
  function saveProp(node, prop) {
    saved.push({
      node: node,
      prop: prop,
      value: node.style.getPropertyValue(prop),
      priority: node.style.getPropertyPriority(prop)
    });
  }
  function setProp(node, prop, value) {
    saveProp(node, prop);
    node.style.setProperty(prop, value, 'important');
  }
  function restoreProps() {
    for (var i = saved.length - 1; i >= 0; i--) {
      var s = saved[i];
      try {
        if (s.value) s.node.style.setProperty(s.prop, s.value, s.priority);
        else s.node.style.removeProperty(s.prop);
      } catch (e) {}
    }
    saved = [];
  }

  var backdrop = document.createElement('div');
  backdrop.id = '__bow-element-fullscreen-backdrop';
  backdrop.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:#111;z-index:2147483645;pointer-events:none;';
  document.documentElement.appendChild(backdrop);

  var props = [
    ['position', 'fixed'],
    ['top', '0'],
    ['right', '0'],
    ['bottom', '0'],
    ['left', '0'],
    ['width', '100vw'],
    ['height', '100vh'],
    ['max-width', 'none'],
    ['max-height', 'none'],
    ['min-width', '0'],
    ['min-height', '0'],
    ['margin', '0'],
    ['box-sizing', 'border-box'],
    ['transform', 'none'],
    ['opacity', '1'],
    ['visibility', 'visible'],
    ['box-shadow', 'none'],
    ['border-radius', '0'],
    ['z-index', '2147483646']
  ];
  var tag = el.tagName ? el.tagName.toUpperCase() : '';
  if (tag === 'IMG' || tag === 'VIDEO') props.push(['object-fit', 'contain']);
  for (var i = 0; i < props.length; i++) setProp(el, props[i][0], props[i][1]);

  var NEUTRAL = {
    'transform': 'none',
    'filter': 'none',
    '-webkit-filter': 'none',
    'backdrop-filter': 'none',
    '-webkit-backdrop-filter': 'none',
    'perspective': 'none',
    'will-change': 'auto',
    'contain': 'none',
    'content-visibility': 'visible',
    'container-type': 'normal',
    'opacity': '1',
    'isolation': 'auto',
    'mix-blend-mode': 'normal',
    'mask': 'none',
    '-webkit-mask': 'none',
    'clip-path': 'none'
  };
  var anc = el.parentElement;
  while (anc && anc.nodeType === 1) {
    var cs = null;
    try { cs = window.getComputedStyle(anc); } catch (e) { cs = null; }
    if (cs) {
      for (var key in NEUTRAL) {
        if (!Object.prototype.hasOwnProperty.call(NEUTRAL, key)) continue;
        var raw = cs.getPropertyValue(key);
        if (!raw) continue;
        var value = raw.trim();
        if (!value || value === NEUTRAL[key]) continue;
        setProp(anc, key, NEUTRAL[key]);
      }
    }
    anc = anc.parentElement;
  }

  var htmlEl = document.documentElement;
  var bodyEl = document.body;
  setProp(htmlEl, 'overflow', 'hidden');
  if (bodyEl && bodyEl !== htmlEl) setProp(bodyEl, 'overflow', 'hidden');

  var restored = false;
  function onKey(e) {
    if (e.key !== 'Escape' && e.keyCode !== 27) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    restore();
  }
  function restore() {
    if (restored) return false;
    restored = true;
    try { window.removeEventListener('keydown', onKey, true); } catch (e) {}
    try {
      if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    } catch (e) {}
    restoreProps();
    try {
      if (window[NS_KEY] && window[NS_KEY].element === el) {
        try { delete window[NS_KEY]; } catch (e2) { window[NS_KEY] = undefined; }
      }
    } catch (e3) {}
    return true;
  }

  window.addEventListener('keydown', onKey, true);
  window[NS_KEY] = { active: true, element: el, selector: SEL, restore: restore };

  return {
    ok: true,
    selector: SEL,
    tag: el.tagName ? el.tagName.toLowerCase() : '',
    count: list.length
  };
})()`

/** 构造「让选择器首个匹配元素全屏」的注入脚本(选择器安全内联) */
export function buildApplyScript(selector: string): string {
  return APPLY_JS_PREFIX + JSON.stringify(selector) + APPLY_JS_SUFFIX
}
