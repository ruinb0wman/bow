/**
 * 手机端的「未发送草稿」(按会话),纯函数、可单测。
 *
 * 为什么要落到 localStorage:切会话丢草稿只是小烦,手机上更常见的是切出去被系统杀页面 ——
 * 只放内存的话回来就没了。
 *
 * **每条草稿都带 cwd**:会话 id 是 bow 的 tabId(`windows.ts` 每次启动从 1 数),重启后会撞;
 * 读的时候 cwd 对不上就当没有 —— 宁可少恢复一次,也不能把 A 项目没发的话递到 B 项目。
 */

export interface Draft {
  /** 记下当时的会话目录,用来防 id 复用 */
  cwd: string
  text: string
  /** 写入时刻:超过上限按它淘汰最旧的 */
  at: number
}

export const DRAFTS_KEY = 'bow.remote.drafts'
/** 最多留这么多个会话的草稿 */
export const MAX_DRAFTS = 20
/** 单条草稿上限(与 `MAX_PROMPT_CHARS` 无关:草稿不是消息,超过这个数一定是贴错了) */
export const MAX_DRAFT_CHARS = 8_000

export type DraftStore = Record<string, Draft>

function isDraft(value: unknown): value is Draft {
  const v = value as Partial<Draft> | null
  return (
    !!v &&
    typeof v.cwd === 'string' &&
    typeof v.text === 'string' &&
    typeof v.at === 'number' &&
    Number.isFinite(v.at)
  )
}

/** 解析存下来的那坨 JSON:坏数据整条丢,不让它挡住输入框 */
export function parseDrafts(raw: string | null): DraftStore {
  if (!raw) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: DraftStore = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || !isDraft(entry)) continue
    out[key] = { cwd: entry.cwd, text: entry.text.slice(0, MAX_DRAFT_CHARS), at: entry.at }
  }
  return out
}

/** 某个会话能恢复的草稿:没有 / cwd 变了(bow 重启后 id 被别的项目复用)都算空 */
export function draftFor(store: DraftStore, id: number, cwd: string): Draft | null {
  const hit = store[String(id)]
  return hit && hit.cwd === cwd && hit.text ? hit : null
}

/** 写一条(空文本 = 删掉);返回新表,不改入参 */
export function withDraft(
  store: DraftStore,
  id: number,
  cwd: string,
  text: string,
  at = Date.now()
): DraftStore {
  const key = String(id)
  const next: DraftStore = { ...store }
  const kept = text.slice(0, MAX_DRAFT_CHARS)
  if (!kept.trim()) delete next[key]
  else next[key] = { cwd, text: kept, at }

  const keys = Object.keys(next)
  if (keys.length > MAX_DRAFTS) {
    // 淘汰最旧的:只丢到上限,顺序按写入时刻而不是键顺序(覆盖写不会刷新键的位置)
    keys.sort((a, b) => next[a].at - next[b].at)
    for (const old of keys.slice(0, keys.length - MAX_DRAFTS)) delete next[old]
  }
  return next
}

/** 会话没了(被关掉 / bow 重启过):把它的草稿一起清掉 */
export function withoutDraft(store: DraftStore, id: number): DraftStore {
  const key = String(id)
  if (!(key in store)) return store
  const next = { ...store }
  delete next[key]
  return next
}
