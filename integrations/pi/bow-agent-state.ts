/**
 * bow 终端状态桥(pi 扩展)
 *
 * managed by bow; reinstall overwrites this file(由 `scripts/install-pi-agent-state.mjs` 写入,
 * 请把自定义改动放到**别的**扩展文件里 —— 这行标记也是安装脚本用来判断「这文件是不是 bow 装的」的依据)。
 *
 * 作用:把 pi 的三态写成一条自定义 OSC 控制序列,bow 的终端插件在 pty 输出里把它剥出来,
 * 于是终端标签能显示「正在执行」角标,并在**需要用户确认** / **任务完成**时弹出右下角通知
 * (点通知进入对应标签)。协议与解析见 bow 仓库的 `src/shared/agentState.ts`。
 *
 * 序列形状:
 *   ESC ] 1337 ; bow ; {"v":1,"state":"blocked","title":"…","text":"…"} BEL
 * 1337 是第三方终端集成常用的私有区间;别的终端对不认识的键一律忽略,所以即使在别的终端里
 * 被放出来也无害 —— 何况这里用 `BOW_TERMINAL` 做了门禁(见下)。
 *
 * 为什么不解析 TUI 文本:pi 自己就有这些事件(`agent_start` / `agent_settled` /
 * `ui_prompt_start` / `ui_prompt_end`,后者自 pi 0.84.4 起提供),不需要猜屏幕内容。
 * 为什么用 `agent_settled` 而不是 `agent_end`:`agent_end` 之后 pi 可能还会重试、压缩或续跑排队的消息,
 * 只有 `agent_settled` 表示「这一轮彻底结束了」。
 *
 * 装法:在 bow 仓库里跑 `node scripts/install-pi-agent-state.mjs`(幂等,可 --uninstall)。
 * 手动试用:`pi --extension <此文件的绝对路径>`。
 *
 * ⚠️ 本文件由 bow 安装脚本管理:重装会覆盖它,请把自定义改动放到别的文件里。
 * ⚠️ 需要 pi ≥ 0.84.4(`ui_prompt_start` / `ui_prompt_end` 引入的版本);更老的 pi 上只是少了
 *    「需要确认」那一档,不会报错(未知事件名的注册永远不触发)。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { basename } from 'node:path'

/** 必须与 bow 侧 `BOW_OSC_PREFIX` 逐字一致 */
const OSC_PREFIX = '\x1b]1337;bow;'
const BEL = '\x07'
const SIGNAL_VERSION = 1

/** bow 的终端插件给 pty 注入的门禁(见 bow 的 `cleanEnv`);其它终端里这个扩展什么都不做 */
const IN_BOW = process.env.BOW_TERMINAL === '1'

type State = 'working' | 'blocked' | 'idle'

interface Payload {
  v: number
  state: State
  done?: boolean
  agent?: string
  title?: string
  text?: string
}

export default function (pi: ExtensionAPI) {
  if (!IN_BOW) return

  /** 只有顶层会话上报:子代理跑在独立进程里、输出也不进这个 pty,但双重保险不嫌多 */
  let root = false
  /** agent 正在跑 */
  let active = false
  /** 这一轮真的开跑过(`agent_settled` 时区分「完成」与「本来就没跑」) */
  let activeRun = false
  /** `ctx.ui.*` 对话框的嵌套深度(select 里再弹 confirm 是两层) */
  let promptDepth = 0
  let promptTitle: string | undefined
  /** 去重键:同一状态不重复喊(心跳式输出会白白惊动 bow 的标签栏) */
  let lastKey = ''

  /** 会话标签:有名字用名字,否则用 cwd 的目录名(`π - bow - /path/to/repo`) */
  function sessionLabel(): string {
    let name: string | undefined
    try {
      name = (pi as unknown as { getSessionName?: () => string | undefined }).getSessionName?.()
    } catch {
      name = undefined
    }
    const dir = basename(process.cwd()) || process.cwd()
    return name ? `π - ${name} - ${dir}` : `π - ${dir}`
  }

  function emit(state: State, done = false, title?: string, text?: string): void {
    const key = [state, done ? 1 : 0, title ?? '', text ?? ''].join('|')
    if (key === lastKey) return
    lastKey = key
    const payload: Payload = { v: SIGNAL_VERSION, state, agent: 'pi' }
    if (done) payload.done = true
    if (title) payload.title = title
    if (text) payload.text = text
    // 只写一条零宽 OSC:与 pi 自己的 TUI 渲染同线程串行,不会撕裂在某一帧中间
    // (pi 自己的 `9;4` 进度序列就是这么写的)。JSON.stringify 保证串里不会出现裸 BEL / ESC。
    process.stdout.write(`${OSC_PREFIX}${JSON.stringify(payload)}${BEL}`)
  }

  /** 由当前记账推出该报哪一态 */
  function publish(done = false): void {
    const label = sessionLabel()
    if (promptDepth > 0) emit('blocked', false, promptTitle, label)
    else if (active) emit('working', false, undefined, label)
    else emit('idle', done, undefined, label)
  }

  pi.on('session_start', (_event, ctx) => {
    // 只有交互式 TUI 有 pty;RPC / JSON / print 模式没有「终端标签」可显示
    if (ctx?.mode !== 'tui') return
    root = true
    active = typeof ctx.isIdle === 'function' ? ctx.isIdle() === false : false
    // reload 会替换扩展运行时:若此刻 agent 正在跑,reload 不会再发 agent_start
    activeRun = active
    publish()
  })

  pi.on('agent_start', () => {
    if (!root) return
    active = true
    activeRun = true
    publish()
  })

  pi.on('agent_settled', (_event, ctx) => {
    if (!root) return
    if (typeof ctx?.isIdle === 'function' && ctx.isIdle() !== true) return
    const done = activeRun
    active = false
    activeRun = false
    publish(done)
  })

  pi.on('ui_prompt_start', (event) => {
    if (!root) return
    promptDepth += 1
    promptTitle = typeof event?.title === 'string' ? event.title : undefined
    publish()
  })

  pi.on('ui_prompt_end', () => {
    if (!root) return
    promptDepth = Math.max(0, promptDepth - 1)
    if (promptDepth === 0) promptTitle = undefined
    publish()
  })

  pi.on('session_shutdown', () => {
    if (!root) return
    emit('idle')
  })

  // 兜底:被 Ctrl+C / 异常路径带走时也别让 bow 的角标永远停在「正在执行」。
  // pty 上的小写入是同步的(`process.stdout` 指向 tty 时 Node 用同步写),exit 钩子里写得出去。
  process.on('exit', () => emit('idle'))
}
