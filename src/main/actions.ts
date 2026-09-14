/** 页面操作:通过 executeJavaScript 注入执行,带统一超时与错误包装 */

import type { WebContents } from 'electron'
import type { ActionResult, PageSnapshot } from '@shared/types'
import { logError } from './logger'

const EXEC_TIMEOUT = 10_000

/** 注入执行:fn 为函数源码字符串,args 会被 JSON 编码传入;统一返回 {ok, ...} */
async function runInPage(wc: WebContents, fnSource: string, args: unknown[]): Promise<ActionResult> {
  const code = `(function(){
    "use strict";
    try {
      var fn = ${fnSource};
      var result = fn.apply(null, ${JSON.stringify(args)});
      if (result && typeof result.then === 'function') return result; // 不允许异步,防注入挂死
      return JSON.stringify({ ok: true, result: result });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
    }
  })()`
  return await Promise.race<ActionResult>([
    wc.executeJavaScript(code, true).then((raw) => {
      const parsed = JSON.parse(String(raw))
      if (parsed.ok) {
        return { ok: true, result: (parsed.result ?? null) as unknown }
      }
      return { ok: false, error: parsed.error }
    }),
    new Promise<ActionResult>((resolve) =>
      setTimeout(() => resolve({ ok: false, error: '页面脚本执行超时' }), EXEC_TIMEOUT)
    )
  ])
}

const SNAPSHOT_FN = `function __mcpSnapshot__(maxElements){
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

const CLICK_FN = `function __mcpClick__(sel){
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

const TYPE_FN = `function __mcpType__(sel, text, clear){
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

const SCROLL_FN = `function __mcpScroll__(sel, direction, amount){
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
 * CLICK / TYPE / SCROLL 的注入函数把失败放在 result.error(而不是抛出),
 * 经 runInPage 包装后会得到 ok:true —— 这里统一提升为顶层失败,
 * 否则「点不到元素」「不是可输入元素」会被上报成成功。
 */
function lift(result: ActionResult): ActionResult {
  const err = (result.result as { error?: unknown } | null)?.error
  if (result.ok && typeof err === 'string' && err) return { ok: false, error: err }
  return result
}

export async function pageSnapshot(wc: WebContents, maxElements = 200): Promise<ActionResult & { data?: PageSnapshot }> {
  const res = await runInPage(wc, SNAPSHOT_FN, [maxElements])
  if (!res.ok) return res
  return { ...res, data: (res.result ?? undefined) as PageSnapshot | undefined }
}

export async function pageClick(wc: WebContents, selector: string): Promise<ActionResult> {
  return lift(await runInPage(wc, CLICK_FN, [selector]))
}

export async function pageType(wc: WebContents, selector: string, text: string, clear: boolean): Promise<ActionResult> {
  return lift(await runInPage(wc, TYPE_FN, [selector, text, clear]))
}

export async function pageScroll(
  wc: WebContents,
  selector: string | null,
  direction: 'up' | 'down' | 'top' | 'bottom',
  amount: number
): Promise<ActionResult> {
  return lift(await runInPage(wc, SCROLL_FN, [selector, direction, amount]))
}

export type PressKeySpec = { keyCode: string; modifiers?: Modifier[] }

type Modifier = 'shift' | 'control' | 'ctrl' | 'alt' | 'meta' | 'command' | 'cmd'

/** 按键事件(原生 sendInputEvent,作用于当前聚焦元素) */
export async function pressKey(wc: WebContents, key: string): Promise<ActionResult> {
  const spec = resolveKey(key)
  if (!spec) return { ok: false, error: '不支持的按键: ' + key }
  const { keyCode, modifiers } = spec
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  wc.sendInputEvent({ type: 'char', keyCode, modifiers })
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  return { ok: true, key, keyCode }
}

const MOD_MAP: Record<string, Modifier> = {
  ctrl: 'control',
  control: 'control',
  alt: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta'
}

function resolveKey(key: string): PressKeySpec | null {
  const parts = key.split('+').map((p) => p.trim().toLowerCase())
  const mods = parts.filter((p) => MOD_MAP[p]) as Modifier[]
  const main = parts.find((p) => !MOD_MAP[p])
  // 纯修饰键(如裸 'Ctrl')只会生成空 keyCode 的无效事件,却返回 ok —— 直接判为不支持
  if (!main) return null
  const keyAlias: Record<string, string> = {
    enter: 'Enter',
    return: 'Enter',
    tab: 'Tab',
    escape: 'Escape',
    esc: 'Escape',
    space: ' ',
    spacebar: ' ',
    backspace: 'Backspace',
    delete: 'Delete',
    del: 'Delete',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown'
  }
  const keyCode = main.length === 1 && main !== ' ' ? main.toUpperCase() : keyAlias[main] ?? main
  return { keyCode, modifiers: mods }
}

/** 截图:capturePage → PNG base64 */
export async function pageScreenshot(wc: WebContents): Promise<ActionResult & { data?: { pngBase64: string } }> {
  try {
    const image = await wc.capturePage()
    if (image.isEmpty()) return { ok: false, error: '截图为空(页面可能尚未渲染)' }
    return { ok: true, data: { pngBase64: image.toPNG().toString('base64') } }
  } catch (e) {
    logError('截图失败', e)
    return { ok: false, error: String((e as Error).message ?? e) }
  }
}

/** 轮询间隔;LOAD_GRACE_MS 用于消解「loadURL 已发出、did-start-loading 还没到」的竞态 */
const POLL_INTERVAL_MS = 120
const LOAD_GRACE_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 等待标签页主文档加载完成。
 * did-finish-load / did-fail-load 是权威信号;轮询只兜底两种情况:调用时加载已在途中
 * (事件在监听注册前就发生),或调用时加载早已结束(此时宽限期内可直接返回)。
 * 返回体里的 waited 表示是否真的观察到了加载过程,waited=false 说明页面在调用时就已就绪。
 */
export async function waitForLoad(wc: WebContents, timeoutMs = 15_000): Promise<ActionResult> {
  if (wc.isDestroyed()) return { ok: false, error: '标签页已关闭' }
  return new Promise<ActionResult>((resolve) => {
    let settled = false
    let sawLoading = wc.isLoading()
    let timer: ReturnType<typeof setTimeout> | null = null
    let poller: ReturnType<typeof setInterval> | null = null
    const finish = (result: ActionResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (poller) clearInterval(poller)
      wc.removeListener('did-start-loading', onStart)
      wc.removeListener('did-finish-load', onFinish)
      wc.removeListener('did-fail-load', onFail)
      wc.removeListener('destroyed', onDestroyed)
      resolve(result)
    }
    const onStart = (): void => {
      sawLoading = true
    }
    const onFinish = (): void => finish({ ok: true, url: wc.getURL(), waited: true })
    const onFail = (_e: unknown, code: number, desc: string, _url: string, isMain: boolean): void => {
      if (!isMain || code === -3 /* ERR_ABORTED,常由页面自身发起的重定向/中止触发 */) return
      finish({ ok: false, error: `加载失败(${code}): ${desc}` })
    }
    const onDestroyed = (): void => finish({ ok: false, error: '标签页在加载过程中被关闭' })
    const startedAt = Date.now()
    poller = setInterval(() => {
      if (wc.isDestroyed()) {
        finish({ ok: false, error: '标签页在加载过程中被关闭' })
        return
      }
      if (wc.isLoading()) {
        sawLoading = true
        return
      }
      if (sawLoading || Date.now() - startedAt >= LOAD_GRACE_MS) {
        finish({ ok: true, url: wc.getURL(), waited: sawLoading })
      }
    }, POLL_INTERVAL_MS)
    timer = setTimeout(() => finish({ ok: false, error: `等待加载超时(${timeoutMs}ms)` }), timeoutMs)
    wc.on('did-start-loading', onStart)
    wc.on('did-finish-load', onFinish)
    wc.on('did-fail-load', onFail)
    wc.on('destroyed', onDestroyed)
  })
}

export type WaitSelectorState = 'attached' | 'visible' | 'hidden' | 'detached'

const WAIT_SELECTOR_FN = `function __mcpWaitSelector__(sel, state){
  var el = document.querySelector(sel); // 选择器非法会抛错,由 runInPage 转成 ok:false
  if (state === 'attached') return !!el;
  if (state === 'detached') return !el;
  var visible = false;
  if (el) {
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    visible = !(r.width === 0 && r.height === 0) && s.display !== 'none' &&
      s.visibility !== 'hidden' && s.opacity !== '0';
  }
  return state === 'visible' ? visible : !visible;
}`

/**
 * 等待选择器达到指定状态(默认可见)。
 * 选择器非法等脚本错误会立即失败并原样上报,不会空等到超时。
 */
export async function waitForSelector(
  wc: WebContents,
  selector: string,
  state: WaitSelectorState = 'visible',
  timeoutMs = 10_000
): Promise<ActionResult> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let res: ActionResult
    try {
      res = await runInPage(wc, WAIT_SELECTOR_FN, [selector, state])
    } catch (e) {
      return { ok: false, error: `页面不可用: ${String((e as Error)?.message ?? e)}` }
    }
    if (!res.ok) return res
    if (res.result === true) return { ok: true, selector, state }
    const left = deadline - Date.now()
    if (left <= 0) {
      return { ok: false, error: `等待超时(${timeoutMs}ms):${selector} 未达到状态 ${state}` }
    }
    await sleep(Math.min(POLL_INTERVAL_MS, left))
  }
}