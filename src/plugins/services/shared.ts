/**
 * 自定义本地服务(services)的跨端契约 + 纯逻辑(不引 electron / DOM,可单测)。
 *
 * 和 `ok` 插件的分工:那条服务的端口是随机的,只能从启动横幅里嗅;这里的前端地址是**用户填的**,
 * 探活就能判定「该起 / 该开」,所以不需要任何端口解析。别把 ok 的嗅探逻辑往这搬。
 */

import { normalizeFloatPrefs, type FloatPrefs } from '@shared/floatWindow'

export interface ServiceConfig {
  /** 内部标识:IPC 参数、状态表的 key、工具栏的 `:key`。用户不可见,归一化时保证唯一 */
  id: string
  name: string
  /** lucide 图标名,取值见 `ui/icons.ts`;没登记的名字回落 Play */
  icon: string
  /** 完整命令行,经用户的登录 shell 执行(可以写 `cd X && bun dev`) */
  command: string
  /** 前端地址:既用于探活,也是点开时打开的 URL */
  url: string
  /**
   * 可选:探活响应体必须包含它。
   * 端口撞车时(`exp1` 与 `aict1` 的 dev 脚本都写死 1420)只有它能分辨「这个端口上跑的是不是这条服务」。
   */
  check: string
  /** bow 启动就拉起来。默认 false —— 别把一堆 dev server 一起拎起来 */
  autoStart: boolean
  /**
   * 配了才用浮窗打开(位置 + 尺寸);**没这个字段 = 点图标照旧开标签**。
   * 缺席与「脏值」的差别由 `normalizeFloatPrefs` 决定(见那个函数的注释)。
   */
  float?: FloatPrefs
}

export interface ServicesSettings {
  services: ServiceConfig[]
}

export type ServicePhase = 'stopped' | 'starting' | 'running' | 'error'

export interface ServiceStatus {
  id: string
  phase: ServicePhase
  /** 进程是不是 bow 起的。false = 已经在跑(终端里手动起的),bow 只用不管 */
  owned: boolean
  error: string | null
}

export interface ServicesState {
  settings: ServicesSettings
  statuses: ServiceStatus[]
}

/** `ensure` 的返回值:工具栏只需要「开哪个 URL」和「为什么没开成」 */
export interface EnsureResult {
  phase: ServicePhase
  url: string | null
  error: string | null
}

export const SERVICES_EVENT = { changed: 'changed' } as const

export const DEFAULT_SETTINGS: ServicesSettings = { services: [] }

/** 工具栏就一行,再多就该换聚合面板了(见 ui/ServicesToolbar.vue 的注释) */
export const MAX_SERVICES = 8

/** 图标名的合法形态:归一化只做形状检查,名字认不认得出由渲染层回落 */
const ICON_RE = /^[A-Za-z][A-Za-z0-9]{0,24}$/
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 前端地址归一:允许只写 `127.0.0.1:8080`(补 `http://`);带了非 http(s) 协议的一律当空。
 * `fetch` 只认带协议的地址,让用户去补协议是没必要的摩擦;而 `ftp://x` 补成 `http://ftp://x`
 * 只会得到一条永远探不通的服务,不如当场归零由 start() 报错。
 */
function normalizeUrl(raw: string): string {
  if (!raw || /\s/.test(raw)) return ''
  if (ANY_SCHEME.test(raw)) return /^https?:\/\//i.test(raw) ? raw : ''
  return `http://${raw}`
}

/**
 * 设置归一:丢空项、补 id、去重、限条数。
 *
 * 逐条丢弃而不是整体回退 —— 设置页是一行一行改的,一条填坏不该把别人一起清掉。
 */
export function normalizeSettings(raw: unknown): ServicesSettings {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const list = Array.isArray(obj.services) ? obj.services : []

  const services: ServiceConfig[] = []
  const usedIds = new Set<string>()

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const command = asString(entry.command)
    const url = normalizeUrl(asString(entry.url))
    // 两个都空 = 没意义的一行(设置页新增后没填);只剩一个也留着 ——
    // 用户是逐字段填的,填到一半就把行吞掉会让人以为点错了。真起来不了由 start() 报原因。
    if (!command && !url) continue

    const wanted = asString(entry.id)
    let id = ID_RE.test(wanted) ? wanted : ''
    if (!id || usedIds.has(id)) {
      let n = services.length + 1
      while (usedIds.has(`s${n}`)) n += 1
      id = `s${n}`
    }
    usedIds.add(id)

    const icon = asString(entry.icon)
    // 没配浮窗时**不写这个键**:落盘 JSON 里也就不会出现,老配置与新装的完全等价
    const float = normalizeFloatPrefs(entry.float)
    services.push({
      id,
      name: asString(entry.name) || url.replace(/^https?:\/\//i, ''),
      icon: ICON_RE.test(icon) ? icon : 'Play',
      command,
      url,
      check: asString(entry.check),
      autoStart: entry.autoStart === true,
      ...(float ? { float } : {})
    })
    if (services.length >= MAX_SERVICES) break
  }

  return { services }
}

/** 探活结果的判定:`check` 为空 = 只要通了就算。响应体只需前一段,见 main.ts 的 probe */
export function checkMatches(body: string, check: string): boolean {
  const needle = check.trim()
  return needle === '' || body.includes(needle)
}

/**
 * 标签页是不是这条服务的。
 *
 * 去尾斜杠后按前缀比较:浏览器会把 `http://x:8080` 记成 `http://x:8080/`,子路径(`/docs`)
 * 也算同一条服务;但前缀后面的第一个字符必须是 `/` `?` `#` 或结尾 —— 否则 `:8080` 会
 * 误吞 `:80800`(`exp1` 与 `aict1` 就是两个相邻端口的 vite,这类误判会直接开错标签)。
 */
export function serviceUrlMatches(tabUrl: string, url: string): boolean {
  const target = url.replace(/\/+$/, '').toLowerCase()
  if (!target) return false
  const tab = tabUrl.toLowerCase()
  if (!tab.startsWith(target)) return false
  return /^[/?#]/.test(tab.slice(target.length)) || tab.length === target.length
}

/** 设置里改了两条服务就不该互相影响:只比较真正影响进程的字段 */
export function commandChanged(before: ServiceConfig, after: ServiceConfig): boolean {
  return before.command !== after.command || before.url !== after.url
}
