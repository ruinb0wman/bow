/**
 * 文件管理插件注入到页面里的探测脚本(纯字符串,主进程与渲染层都不跑它,便于单测与审阅)。
 *
 * 为什么探一下而不是「直接给每个标签页挂接管」:接管要**一直**占着该标签的调试器,
 * 而调试器与 DevTools 互斥(electron.d.ts 写明 DevTools 被唤起会终止我们的会话)。
 * 所以只在**页面里真有 file input**时才挂 —— 纯浏览的标签页完全不受影响。
 *
 * ⚠️ 这只是一次**探测**,不是安全边界:真正的判断(能不能塞文件、塞给谁)在主进程与 CDP 那边。
 * 探测失败(拿不到 DOM / 页面还没渲染完)一律按「没有」处理,大不了不接管。
 */
export const HAS_FILE_INPUT_FN = `(() => {
  try {
    return document.querySelectorAll('input[type=file]').length > 0
  } catch {
    return false
  }
})()`
