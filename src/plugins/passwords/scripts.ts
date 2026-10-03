/**
 * 密码插件的页面注入脚本(**纯字符串**,无 electron / DOM 类型依赖,可被纯 node 单测)。
 *
 * 四个脚本都由主进程经 `ctx.pages.execute` 注入页面**主世界**(普通标签页没有 preload,
 * 这是唯一通路,见 `src/main/tabManager.ts` 的注释):
 * - `DETECT_JS`:当前页有没有密码框 / 用户名字段(**绝不返回字段的值**);
 * - `buildPickerScript(candidates)`:在密码框下弹一个 Shadow DOM 账号下拉,
 *   Promise 解析为 `{ entryId }` 或 `{ cancelled: true }` —— **只带用户名,不带密码**;
 * - `buildFillScript(values)`:把选定条目的用户名 / 密码写进字段,返回 `{ ok, filled }`;
 * - `READ_FIELDS_JS`:读取当前字段值(只有面板的「从当前页面保存」会调它);
 * - `PICKER_TEARDOWN_JS`:切标签 / 导航 / 超时时拆掉下拉。
 *
 * 约定:脚本内**不使用反引号与 ${ 插值**,
 * 一切数据经 `JSON.stringify` 内联 —— 用户名 / 标题里的引号、反斜杠、中文都不会破坏代码。
 */

export interface PickerCandidate {
  id: string
  title: string
  username: string
}

export interface FillValues {
  username: string | null
  password: string | null
}

/** 页面侧句柄(拆除脚本与「已有一个下拉」判定都认它) */
export const PICKER_GLOBAL = '__bowPasswordPicker'

const PREFIX = "(function () {\n  'use strict';\n"
const SUFFIX = '\n})()'

/**
 * 字段定位与赋值助手。四个脚本都要重新定义它们(每次 executeJavaScript 都是独立上下文),
 * 所以抽成一段共享字符串,**避免四份实现各自漂移**。
 */
const HELPERS_JS: string = String.raw`
function __bowPwVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.disabled || el.readOnly) return false;
  var r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  var s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
  return true;
}
function __bowPwAllInputs() {
  var list;
  try { list = document.querySelectorAll('input'); } catch (e) { list = []; }
  return Array.prototype.slice.call(list);
}
function __bowPwTextish(el) {
  var t = (el.type || '').toLowerCase();
  if (t === '' || t === 'text' || t === 'email' || t === 'tel' || t === 'username') return true;
  return false;
}
function __bowPwPasswordField() {
  var inputs = __bowPwAllInputs();
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    if ((el.type || '').toLowerCase() === 'password' && __bowPwVisible(el)) return el;
  }
  return null;
}
function __bowPwUsernameField(pw) {
  var inputs = __bowPwAllInputs();
  var fallback = null;
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    if (!__bowPwVisible(el) || !__bowPwTextish(el)) continue;
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac.indexOf('username') >= 0 || ac.indexOf('email') >= 0) {
      if (!pw || el.form === pw.form) return el;
      if (!fallback) fallback = el;
    }
  }
  if (pw) {
    var same = [];
    for (var j = 0; j < inputs.length; j++) {
      var e2 = inputs[j];
      if (!__bowPwVisible(e2) || !__bowPwTextish(e2)) continue;
      if (e2.form !== pw.form) continue;
      var pos = pw.compareDocumentPosition(e2);
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) same.push(e2);
    }
    if (same.length) return same[same.length - 1];
  }
  return fallback;
}
function __bowPwSetValue(el, value) {
  var tag = el.tagName ? el.tagName.toLowerCase() : '';
  var text = String(value == null ? '' : value);
  if (tag === 'input' || tag === 'textarea') {
    var proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    try { el.focus(); } catch (e) {}
    try {
      if (desc && desc.set) { desc.set.call(el, ''); desc.set.call(el, text); }
      else { el.value = text; }
    } catch (e) {
      try { el.value = text; } catch (e2) {}
    }
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    return true;
  }
  if (el.isContentEditable) {
    try { el.textContent = text; } catch (e) {}
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    return true;
  }
  return false;
}
`

function wrap(body: string): string {
  return PREFIX + HELPERS_JS + body + SUFFIX
}

/** 探测:只回布尔与 URL,不回任何字段值 */
export const DETECT_JS: string = wrap(
  String.raw`
  var pw = __bowPwPasswordField();
  var un = __bowPwUsernameField(pw);
  return {
    ok: true,
    url: location.href,
    title: document.title,
    hasPassword: !!pw,
    hasUsername: !!un
  };`
)

/** 读取当前页面的字段值(仅供「从当前页面保存」;这是唯一读取密码值的脚本) */
export const READ_FIELDS_JS: string = wrap(
  String.raw`
  var pw = __bowPwPasswordField();
  var un = __bowPwUsernameField(pw);
  return {
    ok: true,
    url: location.href,
    title: document.title,
    hasPassword: !!pw,
    hasUsername: !!un,
    username: un ? String(un.value == null ? '' : un.value) : '',
    password: pw ? String(pw.value == null ? '' : pw.value) : ''
  };`
)

const FILL_BODY: string = String.raw`
  var pw = __bowPwPasswordField();
  var un = __bowPwUsernameField(pw);
  var filled = { username: false, password: false };
  if (pw && values.password != null) filled.password = __bowPwSetValue(pw, values.password);
  if (un && values.username != null && String(values.username) !== '') {
    filled.username = __bowPwSetValue(un, values.username);
  }
  if (pw) { try { pw.focus(); } catch (e) {} }
  if (!pw && !un) return { ok: false, filled: filled, error: '未找到可填写的字段' };
  return { ok: true, filled: filled };`

/** 把一条凭据写进当前页(受控输入框也认:原生 setter + input/change) */
export function buildFillScript(values: FillValues): string {
  return PREFIX + HELPERS_JS + '\n  var values = ' + JSON.stringify(values) + ';\n' + FILL_BODY + SUFFIX
}

const PICKER_BODY: string = String.raw`
  var W = window;
  if (W.__bowPasswordPicker && typeof W.__bowPasswordPicker.stop === 'function') {
    try { W.__bowPasswordPicker.stop(); } catch (e) {}
  }
  return new Promise(function (resolve) {
    var anchor = __bowPwPasswordField() || __bowPwUsernameField(null);
    if (!anchor || candidates.length === 0) { resolve({ error: 'no-field' }); return; }

    var host = document.createElement('div');
    host.id = '__bow-password-picker-host';
    var root;
    try { root = host.attachShadow({ mode: 'open' }); } catch (e) { root = host; }

    var CSS = ':host{all:initial}' +
      '.menu{position:fixed;z-index:2147483647;min-width:220px;max-width:340px;background:#1e1f24;color:#e8e8ea;border:1px solid #3a3d44;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.45);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}' +
      '.head{padding:6px 10px;font-size:11px;color:#9aa0aa;border-bottom:1px solid #31343b}' +
      '.item{display:flex;flex-direction:column;gap:2px;padding:7px 10px;cursor:default}' +
      '.item.sel{background:#2b3a55}' +
      '.t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.u{color:#9aa0aa;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';

    function attachStyles(shadow) {
      try {
        if (typeof CSSStyleSheet === 'function') {
          var sheet = new CSSStyleSheet();
          sheet.replaceSync(CSS);
          shadow.adoptedStyleSheets = [sheet];
          return;
        }
      } catch (e) {}
      var style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
    }

    var menu = document.createElement('div');
    menu.className = 'menu';
    var head = document.createElement('div');
    head.className = 'head';
    head.textContent = '选择要填充的账号';
    menu.appendChild(head);

    var items = [];
    var sel = 0;
    var done = false;

    function makeRow(c, idx) {
      var row = document.createElement('div');
      row.className = 'item';
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = c.title || c.username || '未命名';
      var u = document.createElement('div');
      u.className = 'u';
      u.textContent = c.username || '(无用户名)';
      row.appendChild(t);
      row.appendChild(u);
      row.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        choose(idx);
      });
      row.addEventListener('mouseenter', function () { select(idx); });
      items.push(row);
      return row;
    }

    for (var i = 0; i < candidates.length; i++) menu.appendChild(makeRow(candidates[i], i));
    root.appendChild(menu);
    attachStyles(root);
    document.documentElement.appendChild(host);

    function select(i) {
      if (!items.length) return;
      sel = (i + items.length) % items.length;
      for (var k = 0; k < items.length; k++) items[k].className = k === sel ? 'item sel' : 'item';
    }
    function place() {
      var r = anchor.getBoundingClientRect();
      var mw = menu.offsetWidth || 240;
      var mh = menu.offsetHeight || 56;
      var vw = W.innerWidth || 0;
      var vh = W.innerHeight || 0;
      var left = Math.min(Math.max(4, r.left), Math.max(4, vw - mw - 4));
      var top = r.bottom + 4;
      if (top + mh > vh - 4) top = Math.max(4, r.top - mh - 4);
      menu.style.left = Math.round(left) + 'px';
      menu.style.top = Math.round(top) + 'px';
    }
    function cleanup() {
      document.removeEventListener('mousedown', onOutside, true);
      W.removeEventListener('keydown', onKey, true);
      W.removeEventListener('scroll', place, true);
      W.removeEventListener('resize', place, true);
      if (host.parentNode) host.parentNode.removeChild(host);
      try { delete W.__bowPasswordPicker; } catch (e) { W.__bowPasswordPicker = undefined; }
    }
    function finish(res) {
      if (done) return;
      done = true;
      cleanup();
      resolve(res);
    }
    function choose(i) {
      var c = candidates[i];
      if (!c) return;
      finish({ entryId: c.id });
    }
    function onOutside(e) {
      var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (path.indexOf(host) >= 0 || e.target === host) return;
      finish({ cancelled: true });
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish({ cancelled: true }); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); select(sel + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); select(sel - 1); return; }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); choose(sel); return; }
    }

    W.__bowPasswordPicker = { stop: function () { finish({ cancelled: true }); } };
    select(0);
    place();
    document.addEventListener('mousedown', onOutside, true);
    W.addEventListener('keydown', onKey, true);
    W.addEventListener('scroll', place, true);
    W.addEventListener('resize', place, true);
  });`

/** 弹账号下拉;candidates **不含密码** */
export function buildPickerScript(candidates: PickerCandidate[]): string {
  return (
    PREFIX +
    HELPERS_JS +
    '\n  var candidates = ' +
    JSON.stringify(candidates) +
    ';\n' +
    PICKER_BODY +
    SUFFIX
  )
}

/** 拆掉页面上的下拉(切标签 / 导航 / 超时) */
export const PICKER_TEARDOWN_JS: string =
  "(function () {\n  try {\n    if (window." +
  PICKER_GLOBAL +
  " && typeof window." +
  PICKER_GLOBAL +
  ".stop === 'function') window." +
  PICKER_GLOBAL +
  '.stop();\n  } catch (e) {}\n})()'
