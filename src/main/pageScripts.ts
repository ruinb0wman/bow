/**
 * 页面注入脚本的**唯一来源**(纯字符串,不 import electron ⇒ 插件与纯 node 单测都能用)。
 *
 * 两个使用方:
 * 1. `main/actions.ts` —— bow 自己的标签页经 `executeJavaScript` 注入(核心 MCP 工具 browser_snapshot 等);
 * 2. `plugins/device-inspect/cdp.ts` —— 手机页面经 CDP `Runtime.evaluate` 注入(device_snapshot / device_scroll)。
 *
 * 为什么必须共用一份:手机上的 `device_snapshot` 与 `browser_snapshot` 必须给出**同一种**
 * 元素形状与 `selector` 算法(LLM 的经验才通用)。这类「同一个事实写两遍必然漂移」的教训见
 * `@shared/devtools` 顶部注释。单独的注入脚本(只有一处用)请留在各自模块里。
 *
 * 约定:`__mcpXxx__` 是函数声明(不是表达式),调用方拼成 `(__mcpXxx__)(...args)` 执行。
 */

export const SNAPSHOT_FN = `function __mcpSnapshot__(maxElements){
  var out = [];
  function isVisible(el){
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var s = getComputedStyle(el);
    return !(s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0');
  }
  function selFor(el){
    if (el.id) return '#' + CSS.escape(el.id);
    var attrs = ['data-testid','data-test','data-qa','name','aria-label','placeholder'];
    for (var i = 0; i < attrs.length; i++){
      var v = el.getAttribute(attrs[i]);
      if (v) return el.tagName.toLowerCase() + '[' + attrs[i] + '=\"' + String(v).replace(/"/g,'\\\\"') + '\"]';
    }
    var parts = [], cur = el;
    for (var d = 0; d < 4 && cur && cur !== document.documentElement && cur.parentElement; d++){
      var peers = Array.prototype.filter.call(cur.parentElement.children, function(c){ return c.tagName === cur.tagName; });
      var idx = peers.indexOf(cur) + 1;
      parts.unshift(cur.tagName.toLowerCase() + ':nth-of-type(' + idx + ')');
      cur = cur.parentElement;
    }
    return parts.join('>') || el.tagName.toLowerCase();
  }
  function textOf(el){
    var t = (el.innerText || el.value || el.getAttribute('aria-label') || el.textContent || '').toString().trim();
    return t.slice(0, 200);
  }
  var els = document.querySelectorAll([
    'a[href]','button','input','textarea','select','summary',
    '[role="button"]','[role="link"]','[role="checkbox"]','[role="radio"]',
    '[role="textbox"]','[role="combobox"]','[role="tab"]','[role="menuitem"]',
    '[contenteditable="true"]','[contenteditable=""]'
  ].join(','));
  var limit = maxElements > 0 ? maxElements : 500;
  for (var i = 0; i < els.length && out.length < limit; i++){
    var el = els[i];
    if (el.closest('noscript,script,style')) continue;
    var label = '';
    if (el.labels && el.labels.length) label = el.labels[0].innerText.trim();
    out.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      id: el.id || undefined,
      name: el.getAttribute('name') || undefined,
      type: el.getAttribute('type') || undefined,
      label: label || undefined,
      href: el.tagName === 'A' ? (el.getAttribute('href') || undefined) : undefined,
      text: textOf(el),
      selector: selFor(el),
      visible: isVisible(el)
    });
  }
  return { title: document.title, url: location.href, elements: out };
}`

export const CLICK_FN = `function __mcpClick__(sel){
  var el = document.querySelector(sel);
  if (!el) return { error: '未找到选择器: ' + sel };
  var r = el.getBoundingClientRect();
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
  if (typeof el.focus === 'function') el.focus();
  var opts = { bubbles: true, cancelable: true, view: window, button: 0,
    clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  var tag = el.tagName.toLowerCase();
  var role = el.getAttribute && el.getAttribute('role');
  if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'summary' ||
      tag === 'select' || role === 'button' || role === 'link' ||
      role === 'checkbox' || role === 'radio') {
    try { el.click(); } catch (e) { /* ignore */ }
  }
  return { selector: sel, tag: tag, text: (el.innerText || el.value || '').toString().slice(0, 200) };
}`

export const TYPE_FN = `function __mcpType__(sel, text, clear){
  var el = null;
  if (sel) el = document.querySelector(sel);
  else if (document.activeElement && document.activeElement instanceof HTMLElement) el = document.activeElement;
  if (!el) return { error: '未找到输入目标' + (sel ? ': ' + sel : '') };
  var tag = el.tagName.toLowerCase();
  var isEditable = tag === 'input' || tag === 'textarea' || el.isContentEditable || el.getAttribute('contenteditable') === 'true';
  if (!isEditable) return { error: '目标不是可输入元素: ' + tag };
  el.focus();
  if (tag === 'input' || tag === 'textarea') {
    var proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (clear) setter.call(el, '');
    var value = el.value || '';
    var textStr = String(text || '');
    for (var i = 0; i < textStr.length; i++) {
      value += textStr[i];
      setter.call(el, value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textStr[i] }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selector: sel || '(focused)', value: el.value };
  }
  if (tag === 'select') {
    var opt = Array.prototype.find.call(el.options, function(o){ return o.textContent.trim() === String(text); });
    if (!opt) return { error: '选项不存在: ' + text };
    el.value = opt.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selector: sel, value: el.value };
  }
  el.textContent = (clear ? '' : (el.textContent || '')) + String(text || '');
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(text) }));
  return { selector: sel || '(focused)', value: el.textContent };
}`

export const SCROLL_FN = `function __mcpScroll__(sel, direction, amount){
  var el = sel ? document.querySelector(sel) : null;
  if (sel && !el) return { error: '未找到选择器: ' + sel };
  var target = el || (document.scrollingElement || document.documentElement);
  if (direction === 'top') { target.scrollTop = 0; return { top: 0 }; }
  if (direction === 'bottom') { target.scrollTop = target.scrollHeight; return { top: target.scrollTop }; }
  var step = amount > 0 ? amount : Math.round((el ? target.clientHeight : window.innerHeight) * 0.7);
  if (direction === 'up') step = -step;
  if (direction !== 'down' && direction !== 'up') return { error: 'direction 必须是 up/down/top/bottom' };
  target.scrollTop = Math.max(0, target.scrollTop + step);
  return { top: target.scrollTop };
}`
