/**
 * 设备检查插件的注入脚本(纯字符串,无 electron / DOM 类型依赖)。
 *
 * 两个脚本都由主进程经 CDP `Runtime.evaluate` 注入**手机页面**,返回 `{ok, result}` 之外的对象
 * (失败放在 `result.error`,由 `cdp.ts` 统一提升为顶层失败 —— 与核心 `actions.ts` 的 `lift()` 同口径)。
 *
 * 为什么只有这两个在插件目录里:核心那四个(`@main/pageScripts`)是**两处共用**的(唯一来源),
 * 而这两个只服务手机这条路(点定位、聚焦 + 全选)。判定点 → 真事件、聚焦 → `Input.insertText`,
 * 这一套正是 chrome://inspect 的 screencast 在用的分工:脚本只负责量坐标/摆焦点,**真输入交给 CDP Input**。
 *
 * 约定与 `element-fullscreen/scripts.ts` 一致:函数声明式(`__bowDeviceXxx__`),调用方拼
 * `(__bowDeviceXxx__)(...args)`;脚本内不用反引号与 `${}` 插值,整体 `String.raw` 保留反斜杠。
 */

/**
 * 选择器 → 视口中心点(CSS 像素,**不乘 devicePixelRatio**:`Input.dispatchTouchEvent` 吃的是 CSS px)。
 *
 * `scrollIntoView({block:'center'})` 是必须的:目标可能本来在视口外,量到的坐标会跑到窗口外面,
 * 注入的点击就落在别的元素上(这类「点了没反应」最容易被误判成 touch 注入不支持)。
 */
export const POINT_FN: string = String.raw`function __bowDevicePoint__(sel){
  var el = document.querySelector(sel);
  if (!el) return { error: '未找到选择器: ' + sel };
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
  var r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { error: '元素不可见(尺寸为 0): ' + sel };
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}`

/**
 * 聚焦(input/textarea/contenteditable)+ 可选「全选」。
 *
 * 全选是为 `Input.insertText` 服务的:insertText 走 IME 路径,**会替换当前选区** ——
 * 所以「清空再输入」不需要单独派发清空事件(受控组件也不会被原地改值后回滚)。
 * 返回值里的 `readback` 只为日志/排查,真正的读回在 insertText 之后由 cdp.ts 另做一次。
 */
export const FOCUS_FN: string = String.raw`function __bowDeviceFocus__(sel, clear){
  var el = null;
  if (sel) el = document.querySelector(sel);
  else if (document.activeElement && document.activeElement instanceof HTMLElement) el = document.activeElement;
  if (!el) return { error: '未找到输入目标' + (sel ? ': ' + sel : '') };
  var tag = el.tagName.toLowerCase();
  var editable = tag === 'input' || tag === 'textarea' || el.isContentEditable ||
    el.getAttribute('contenteditable') === 'true';
  if (!editable) return { error: '目标不是可输入元素: ' + tag };
  el.focus();
  var cleared = false;
  if (clear) {
    if (tag === 'input' || tag === 'textarea') {
      if (typeof el.select === 'function') { el.select(); cleared = true; }
    } else {
      var range = document.createRange();
      range.selectNodeContents(el);
      var selection = window.getSelection();
      if (selection) { selection.removeAllRanges(); selection.addRange(range); cleared = true; }
    }
  }
  return {
    selector: sel || '(focused)',
    tag: tag,
    cleared: cleared,
    readback: String(el.value !== undefined ? el.value : (el.textContent || ''))
  };
}`

/**
 * 读回当前聚焦元素的值(`Input.insertText` 之后的回执;与核心 `browser_type` 返回 `value` 同口径)。
 * 元素没有 `value`(contenteditable)→ 用 `textContent`。
 */
export const READ_FOCUSED_FN: string = String.raw`function __bowDeviceReadFocused__(){
  var el = document.activeElement;
  if (!el || !(el instanceof HTMLElement)) return { value: '' };
  return { value: String(el.value !== undefined ? el.value : (el.textContent || '')) };
}`
