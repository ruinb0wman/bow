/**
 * 单实例启动策略。
 *
 * 打包成 bow.exe 之后双击启动,很容易不小心开出第二个浏览器:两个实例都想监听 MCP HTTP 端口,
 * 后起的只能在设置页看到端口占用错误;用户也会困惑于「怎么有两个浏览器」。
 *
 * 例外是 stdio 模式:MCP 客户端会把浏览器当**子进程**拉起,必须允许它与常驻实例并存,
 * 否则子进程一启动就退出,客户端的 stdio 连接直接断掉(`npm run test:mcp` 也会莫名其妙失败)。
 */

/** 只需要窗口的这四件事,便于用普通对象单测 */
export interface FocusableWindow {
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface SingletonDeps {
  /** 是否 stdio MCP 模式(子进程形态,不参与单实例约束) */
  isStdio: boolean
  /** 通常是 `() => app.requestSingleInstanceLock()` */
  requestLock(): boolean
}

/** 本进程是否应当继续启动。stdio 模式恒为 true(不抢锁,允许与常驻实例并存) */
export function acquireSingletonLock(deps: SingletonDeps): boolean {
  if (deps.isStdio) return true
  return deps.requestLock()
}

/** 第二次启动时把已有窗口带到前台。没有任何窗口时返回 false */
export function focusFirstWindow(windows: FocusableWindow[]): boolean {
  const win = windows[0]
  if (!win) return false
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return true
}
