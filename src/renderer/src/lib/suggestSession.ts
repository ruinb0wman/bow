/**
 * 地址栏建议面板的会话状态(纯逻辑:不 import Vue、不碰 DOM,可单测)。
 *
 * 可见性只有两个输入:①地址栏是否握着键盘焦点;②最近一次请求的代(`seq`)。
 *
 * 为什么需要「代」:建议结果来自 `plugins:suggest` 这个**异步** IPC。面板被收掉之后,
 * 在途的那次请求还会落地 —— 不加守卫就会把面板重新弹出来(此时键盘焦点早已不在地址栏,
 * 于是表现为「面板留着但按 Esc 没反应」)。分屏面板为同一类问题加过 `splitMenuSeq`
 * (见 docs/ARCHITECTURE.md §13 第 8 条),这里是同款做法。
 *
 * ⚠️ 任何「焦点离开」或「显式关闭」的路径都**必须**走这里的转移(它负责 +1 代);
 * 只把 `visible` 置假而不作废在途请求,面板就会被迟到的响应复活。
 */
export interface SuggestSession {
  /**
   * 地址栏输入框当前是否持有**键盘**焦点。
   * 由 DOM focus/blur 事件维护,并由主进程的 `chrome:page-focus` 信号兜底 ——
   * 跨 WebContentsView 的焦点切换不保证派发 DOM blur,所以不能只看 DOM。
   */
  focused: boolean
  /** 请求代:每次聚焦 / 失焦 / 关闭都 +1;异步结果只在代一致时生效 */
  seq: number
  /** 面板是否该可见 */
  visible: boolean
}

export const newSession = (): SuggestSession => ({ focused: false, seq: 0, visible: false })

/** 聚焦地址栏:开一代新会话,等结果(此时面板先不显示) */
export const focusedSession = (s: SuggestSession): SuggestSession => ({
  focused: true,
  seq: s.seq + 1,
  visible: false
})

/**
 * DOM blur:作废在途请求,但**不动可见性** —— 失焦可能只是「鼠标点在面板上」
 * (面板用 `mousedown.prevent` 保住输入框焦点,真正收不收交给 120ms 兜底判定)。
 */
export const blurredSession = (s: SuggestSession): SuggestSession => ({
  focused: false,
  seq: s.seq + 1,
  visible: s.visible
})

/** 键盘焦点确实交给页面视图了(主进程 `chrome:page-focus`):收面板 + 作废在途请求 */
export const lostFocusSession = (s: SuggestSession): SuggestSession => ({
  focused: false,
  seq: s.seq + 1,
  visible: false
})

/** 显式关闭(Esc / 选中某行 / 窗口失焦 / 关面板):可见性置假,在途请求一律作废 */
export const dismissedSession = (s: SuggestSession): SuggestSession => ({
  ...s,
  seq: s.seq + 1,
  visible: false
})

/**
 * 建议结果落地:**代不一致或已失焦 → 原样返回**(同一个对象,调用方用 `next === s` 判过期,
 * 连 `suggestions/rows` 的赋值一起跳过);否则 可见 = 有行。
 */
export const withResults = (
  s: SuggestSession,
  snapshot: number,
  rowCount: number
): SuggestSession => (snapshot === s.seq && s.focused ? { ...s, visible: rowCount > 0 } : s)
