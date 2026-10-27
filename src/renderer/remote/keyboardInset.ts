/**
 * 软键盘占了多高(视觉视口与布局视口的差额),写进 `--kb-inset`。
 *
 * 为什么需要它:布局是 `html/body/#app { height: 100% }` 的 flex 列,键盘一弹,
 * - Android Chrome(108+)默认 `resizes-visual`:只缩视觉视口,布局视口不变 → 输入框被盖住;
 *   所以 `index.html` 里加了 `interactive-widget=resizes-content`,让布局也缩(这一步在 Android 上就够了);
 * - iOS Safari 布局视口根本不动,只能自己量。
 *
 * 两步是**叠加安全**的:上了 `resizes-content` 之后 `innerHeight` 一起缩,差额算出来就是 0。
 */
/**
 * 键盘顶起了多少(纯函数,可单测)。
 *
 * `innerHeight` 是布局视口高度;`visualViewport.height` 是键盘压缩后的可见高度,
 * `offsetTop` 是浏览器把可见区整体上推的距离(iOS 上会出现)。
 * 两者都考虑进去,才不会被「工具栏收起」这类几十像素的变化骗到。
 */
export function keyboardInsetOf(innerHeight: number, viewportHeight: number, viewportOffsetTop = 0): number {
  const inset = Math.round(innerHeight - viewportHeight - viewportOffsetTop)
  return inset > 0 ? inset : 0
}

/** 超过这个高度才认定「键盘开着了」(浏览器工具栏收起也会让高度变化几十像素) */
export const KEYBOARD_OPEN_MIN_PX = 80

/**
 * 真的要从页高里扣掉多少。
 *
 * 键盘没开时的差额只是工具栏伸缩/横向滚动带来的几十像素抖动,而 `--kb-inset` 是**永久**扣掉的
 * (还叠加在 `resizes-content` 已经缩过的布局视口上),扣多少就白留多少 —— 所以不到键盘门槛一律算 0。
 */
export function keyboardInsetToDeduct(inset: number): number {
  return inset > KEYBOARD_OPEN_MIN_PX ? inset : 0
}

export function trackKeyboardInset(): void {
  const viewport = window.visualViewport
  const root = document.documentElement
  let frame = 0

  const sync = (): void => {
    // 键盘打开/关闭是动画,一帧一次就够,别在 scroll 事件里同步改样式
    if (frame) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      const inset = keyboardInsetOf(
        window.innerHeight,
        viewport?.height ?? window.innerHeight,
        viewport?.offsetTop ?? 0
      )
      const deduct = keyboardInsetToDeduct(inset)
      root.style.setProperty('--kb-inset', `${deduct}px`)
      root.classList.toggle('kb-open', deduct > 0)
    })
  }

  viewport?.addEventListener('resize', sync)
  viewport?.addEventListener('scroll', sync)
  window.addEventListener('orientationchange', sync)
  // 切后台/窗口被遮挡时 rAF 会暂停,挂着的娜一帧可能永远不跑 —— 不放开 latch 就再也不更新了
  document.addEventListener('visibilitychange', () => {
    frame = 0
    sync()
  })
  sync()
}
