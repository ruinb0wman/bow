/**
 * 页面注入脚本的**唯一来源**(纯字符串,不 import electron ⇒ 插件与纯 node 单测都能用)。
 *
 * 两个使用方:
 * 1. `main/actions.ts` —— bow 自己的标签页经 `executeJavaScript` 注入(核心 MCP 工具 browser_snapshot 等);
 * 2. `plugins/device-inspect/cdp.ts` —— 手机页面经 CDP `Runtime.evaluate` 注入(device_snapshot / device_scroll)。
 *
 * (`READ_FN` 目前只有使用方 1,但**刻意放在这里**:它就是为「两处共用」写的,手机侧加 `device_read` 时
directly 复用同一份,不要另写一份正文抽取。)
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

/**
 * 正文抽取 → markdown(browser_read 的实现)。
 *
 * 为什么要自己写而不是用 readability/turndown:
 * 这份脚本必须**以源码字符串注入页面**(executeJavaScript / CDP Runtime.evaluate),
 * 而 `pageScripts.ts` 的约定是「纯字符串、不引依赖」——引库就得把 bundle 内联成字符串,
 * 既增加构建复杂度,又要求它同时能在手机侧的 C DP 路径上跑。而这里真正需要的只是
 * 「挑出正文容器」+「按 markdown 输出」两件小事,一百多行搞定。
 *
 * 两条刻意的取舍(都是 token 效率优先):
 * - **data URI 图片一律不输出**(内联 base64 能把上下文炸掉);无 alt 的图片也不输出。
 * - 表格加行列上限,超了明确标记截断 —— 大数据表应该用 browser_eval,不该走阅读通道。
 *
 * 正文定位用经典 readability 思路:给候选段落打分再累加到祖先,而不是「选文本最长的容器」
 * (后者一定选到最外层的 wrapper,把导航、侧栏一起带进来)。
 */
export const READ_FN = `function __mcpRead__(opts){
  opts = opts || {};
  var maxChars = opts.maxChars > 0 ? opts.maxChars : 12000;
  // 显式给 selector = 调用方明确要这块内容,不去替他做减法(只挡永远不该出现的脚本/样式)
  var PRUNE = !opts.selector;
  var ALWAYS_NOISE = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  var NOISE_TAGS = { SVG: 1, CANVAS: 1, IFRAME: 1, FORM: 1, NAV: 1, ASIDE: 1, FOOTER: 1, BUTTON: 1,
    INPUT: 1, SELECT: 1, TEXTAREA: 1, VIDEO: 1, AUDIO: 1, DIALOG: 1, MENU: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1 };
  var NOISE_SEL = '[aria-hidden="true"],[role="navigation"],[role="banner"],[role="contentinfo"],' +
    '[role="search"],[role="dialog"],[role="alertdialog"],[hidden],' +
    '.sidebar,.side-bar,.navbar,.nav,.menu,.footer,.header,.ad,.ads,.advert,' +
    '.comment,.comments,.related,.recommend,.share,.social,.breadcrumb,.pagination,.cookie';

  function ws(s){ return String(s == null ? '' : s).replace(/[ \\t\\n\\r\\u00a0]+/g, ' ').trim(); }
  function strip(s){ return String(s == null ? '' : s).replace(/[ \\t\\n\\r\\u00a0]+/g, ''); }
  // innerText 会绕开 display:none 并给块级元素断行,优先用它;但它非标准且 jsdom 里没有,
  // 所以一律经这里取文本,拿不到就落到 textContent(单测才能覆盖这套逻辑)
  function txt(el){
    if (!el) return '';
    var t = el.innerText;
    return String(t == null || t === '' ? (el.textContent || '') : t);
  }

  function isNoise(el){
    if (!el || el.nodeType !== 1) return false;
    if (ALWAYS_NOISE[el.tagName]) return true;
    if (!PRUNE) return false;
    if (NOISE_TAGS[el.tagName]) return true;
    var st = el.getAttribute('style') || '';
    if (st.indexOf('display:none') >= 0 || st.indexOf('display: none') >= 0) return true;
    try { if (el.matches && el.matches(NOISE_SEL)) return true; } catch (e) {}
    return false;
  }
  function inNoise(el){
    var cur = el;
    while (cur && cur !== document.body){
      if (isNoise(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // ---------- 正文定位:段落打分 → 累加到祖先 ----------
  function pickMain(){
    var blocks = document.querySelectorAll('p,pre,blockquote,li,td,h2,h3,h4');
    var acc = new Map();
    var seen = 0;
    for (var i = 0; i < blocks.length && seen < 4000; i++){
      var b = blocks[i];
      if (inNoise(b)) continue;
      seen++;
      var t = strip(txt(b)).length;
      if (t < 20) continue;                                  // 太短,不像正文段落
      var as = b.querySelectorAll('a'), linkLen = 0;
      for (var j = 0; j < as.length; j++) linkLen += strip(txt(as[j])).length;
      if (linkLen / t > 0.5) continue;                       // 一半以上是链接 → 导航/列表页
      var add = 1 + t / 100;
      var cur = b.parentElement, d = 0;
      while (cur && cur !== document.body && d < 5){
        acc.set(cur, (acc.get(cur) || 0) + add / (1 + d));   // 越近的祖先被记的越多
        cur = cur.parentElement; d++;
      }
    }
    var best = null, bs = 0;
    acc.forEach(function(v, k){ if (v > bs){ bs = v; best = k; } });
    return best;
  }

  // ---------- 序列化 ----------
  function absUrl(href){
    if (!href) return '';
    if (href.charAt(0) === '#') return '';
    if (/^javascript:/i.test(href)) return '';
    if (/^data:/i.test(href)) return '';
    try { return new URL(href, location.href).href; } catch (e) { return href; }
  }
  function imgMd(el){
    var alt = ws(el.getAttribute('alt'));
    var src = el.getAttribute('src') || '';
    if (!alt) return '';                                     // 没有 alt 的图片对阅读零信息
    if (/^data:/i.test(src) || !src) return '[图片: ' + alt + ']';
    return '![图片: ' + alt + '](' + absUrl(src) + ')';
  }
  function inline(el){
    var s = '', kids = el.childNodes;
    for (var i = 0; i < kids.length; i++){
      var n = kids[i];
      if (n.nodeType === 3){ s += ws(n.nodeValue) + ' '; continue; }
      if (n.nodeType !== 1) continue;
      if (isNoise(n)) continue;
      var tag = n.tagName;
      if (tag === 'BR'){ s += '\\n'; continue; }
      if (tag === 'A'){
        var linkText = ws(txt(n));
        if (!linkText) continue;
        var u = absUrl(n.getAttribute('href') || '');
        s += u ? '[' + linkText + '](' + u + ')' : linkText;
        continue;
      }
      if (tag === 'IMG'){ var im = imgMd(n); if (im) s += im + ' '; continue; }
      if (tag === 'STRONG' || tag === 'B'){ var sb = ws(txt(n)); if (sb) s += '**' + sb + '** '; continue; }
      if (tag === 'EM' || tag === 'I'){ var se = ws(txt(n)); if (se) s += '*' + se + '* '; continue; }
      if (tag === 'CODE'){ var sc = ws(txt(n)); if (sc) s += '\`' + sc + '\` '; continue; }
      if (tag === 'DEL' || tag === 'S'){ var sd = ws(txt(n)); if (sd) s += '~~' + sd + '~~ '; continue; }
      s += inline(n);
    }
    return s;
  }
  function hasBlockChild(el){
    var BLOCK = { P:1, DIV:1, SECTION:1, ARTICLE:1, UL:1, OL:1, LI:1, TABLE:1, TR:1, H1:1, H2:1, H3:1,
      H4:1, H5:1, H6:1, BLOCKQUOTE:1, PRE:1, FIGURE:1, DETAILS:1, DL:1, HR:1, MAIN:1, HEADER:1, FOOTER:1,
      ASIDE:1, CAPTION:1, FIGCAPTION:1, FORM:1, SUMMARY:1 };
    for (var i = 0; i < el.children.length; i++) if (BLOCK[el.children[i].tagName]) return true;
    return false;
  }
  function eachChild(el, lines){ for (var i = 0; i < el.children.length; i++) walk(el.children[i], lines); }

  /**
   * 整页放宽时**跳掉「链接农场」**:首页/聚合页整页就是一堆链接(实测 BBC 新闻首页的
   * 可见文字 99% 都在 <a> 里),原样倒出来既费 token,又让模型把导航误当成正文。
   * 只用在 wide 这条退路上 —— 正文容器内的「参考资料」类链接列表是有效信息,不能一并剪掉。
   */
  function isLinkFarm(el, minLinks){
    var t = strip(txt(el)).length;
    if (t < 40) return false;                                // 太短的多半是单个按钮/跳转锚
    var as = el.querySelectorAll('a');
    if (as.length < minLinks) return false;
    var linkLen = 0;
    for (var i = 0; i < as.length; i++) linkLen += strip(txt(as[i])).length;
    return linkLen / t > 0.7;
  }
  function wideLines(){
    var out = [], kids = document.body.children;
    for (var i = 0; i < kids.length; i++){
      if (isLinkFarm(kids[i], 3)) continue;
      walk(kids[i], out);
    }
    return out;
  }

  function listItems(el, ordered, listDepth, lines){
    var items = el.children, n = 0, pad = new Array(listDepth + 1).join('  ');
    for (var i = 0; i < items.length; i++){
      var li = items[i];
      if (li.tagName !== 'LI' || isNoise(li)) continue;
      n++;
      var own = '', nested = [];
      for (var j = 0; j < li.childNodes.length; j++){
        var c = li.childNodes[j];
        if (c.nodeType === 3){ own += ws(c.nodeValue) + ' '; continue; }
        if (c.nodeType !== 1) continue;
        if (c.tagName === 'UL' || c.tagName === 'OL'){ nested.push(c); continue; }
        if (isNoise(c)) continue;
        if (hasBlockChild(c)){ nested.push(c); continue; }
        own += inline(c) + ' ';
      }
      own = ws(own);
      if (own) lines.push(pad + (ordered ? n + '. ' : '- ') + own);
      for (var k = 0; k < nested.length; k++){
        var nn = nested[k];
        if (nn.tagName === 'UL' || nn.tagName === 'OL') listItems(nn, nn.tagName === 'OL', listDepth + 1, lines);
        else walk(nn, lines);
      }
    }
  }

  function cellText(td){ return ws(inline(td)).replace(/\\|/g, '\\\\|'); }  function table(el, lines){
    var rows = el.querySelectorAll('tr');
    if (!rows.length) return;
    var cap = el.querySelector('caption');
    if (cap) { var ct = ws(inline(cap)); if (ct) lines.push('**' + ct + '**'); }
    var MAX_ROWS = 60, MAX_COLS = 12;
    var header = null, body = [];
    for (var i = 0; i < rows.length; i++){
      var cells = rows[i].children, vals = [], cols = 0, isHead = false;
      for (var j = 0; j < cells.length && cols < MAX_COLS; j++){
        var c = cells[j];
        if (c.tagName !== 'TD' && c.tagName !== 'TH') continue;
        if (c.tagName === 'TH') isHead = true;
        vals.push(cellText(c));
        cols += Number(c.getAttribute('colspan') || 1) || 1;
      }
      if (!vals.length) continue;
      if (rows[i].parentElement && rows[i].parentElement.tagName === 'THEAD') isHead = true;
      if (isHead && !header) header = vals;
      else if (body.length < MAX_ROWS) body.push(vals);
      else break;
    }
    if (!header) header = body.shift() || [];
    var width = header.length;
    for (var m = 0; m < body.length; m++) width = Math.max(width, body[m].length);
    if (width < 1) return;
    function row(v){
      var o = [];
      for (var i2 = 0; i2 < width; i2++) o.push(v[i2] === undefined ? '' : v[i2]);
      return '| ' + o.join(' | ') + ' |';
    }
    lines.push(row(header));
    var sep = [];
    for (var s2 = 0; s2 < width; s2++) sep.push('---');
    lines.push('| ' + sep.join(' | ') + ' |');
    for (var b2 = 0; b2 < body.length; b2++) lines.push(row(body[b2]));
    if (rows.length > body.length + 1) lines.push('…(表格共 ' + rows.length + ' 行,已截断)')
  }

  function walk(el, lines){
    if (isNoise(el)) return;
    var tag = el.tagName;
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6'){
      var t = ws(inline(el));
      if (t) lines.push(new Array(Math.min(Number(tag.charAt(1)), 4) + 1).join('#') + ' ' + t);
      return;
    }
    if (tag === 'HR'){ lines.push('---'); return; }
    if (tag === 'PRE'){
      var code = String(el.textContent || '').replace(/^\\n+|\\n+$/g, '').replace(/\\n{3,}/g, '\\n\\n');
      if (ws(code)) lines.push('\`\`\`\\n' + code + '\\n\`\`\`');
      return;
    }
    if (tag === 'BLOCKQUOTE'){
      var sub = [];
      eachChild(el, sub);
      if (sub.length) lines.push(sub.map(function(l){ return '> ' + l; }).join('\\n'));
      return;
    }
    if (tag === 'UL' || tag === 'OL'){ listItems(el, tag === 'OL', 0, lines); return; }
    if (tag === 'TABLE'){ table(el, lines); return; }
    if (tag === 'IMG'){ var im = imgMd(el); if (im) lines.push(im); return; }
    if (hasBlockChild(el)){ eachChild(el, lines); return; }
    var p = ws(inline(el));
    if (p) lines.push(p);
  }

  function clean(s){
    return s.split('\\n').map(function(l){ return l.replace(/[ \\t]+$/g, ''); })
      .join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  }

  // ---------- 主流程 ----------
  if (!document.body) return { error: '页面没有可读内容' };
  var mode = 'main', lines = [];

  if (opts.selector){
    var sel = document.querySelector(opts.selector);
    if (!sel) return { error: '未找到选择器: ' + opts.selector };
    mode = 'selector';
    walk(sel, lines);
  } else {
    var main = pickMain();
    if (main){ walk(main, lines); }
    else { mode = 'wide'; lines = wideLines(); }
  }
  var md = clean(lines.join('\\n\\n'));

  // 抽出来的东西**明显不成比例**时,说明正文定位失手(SPA 壳、全 div 排版、选中的是个导航块):
  // 改成从整个 body 再走一遍。两道门都要过 —— 绝对量很小 + 与整页文字量差一个量级 ——
  // 否则短文章会被这个降级意外干掉(早期版本只用一个 200 字的绝对阈值,低分片就翻车了)。
  // wide 那一遍不便宜,所以先用便宜的 md.length 卡一道。
  if (!opts.selector && mode === 'main' && md.length < 400){
    var wideMd = clean(wideLines().join('\\n\\n'));
    if (wideMd.length > md.length * 3) { md = wideMd; mode = 'wide'; }
  }

  // 放宽后仍然一无所获:直说,并指向真正该用的工具。
  // 比空 markdown 好得多 —— 空返回会让模型以为页面是空的,然后开始反复 eval 碰运气。
  if (!md && mode === 'wide'){
    return { error: '这一页没抽出可读正文:整页看起来是链接列表/首页(或者正文由脚本异步渲染)。' +
      '要看可点元素用 browser_snapshot,要取结构化数据用 browser_eval。' };
  }

  var total = md.length, truncated = false;
  if (total > maxChars){
    var cut = md.slice(0, maxChars);
    var br = cut.lastIndexOf('\\n\\n');
    if (br > maxChars * 0.6) cut = cut.slice(0, br);      // 尽量停在段落边界
    md = cut.replace(/[ \\t]+$/g, '') + '\\n\\n…(已截断:正文约 ' + total + ' 字符,此处 ' + cut.length + '。用 selector 收窄或分段读)';
    truncated = true;
  }

  return {
    title: document.title || '', url: location.href, mode: mode,
    markdown: md, chars: md.length, truncated: truncated
  };
}`
