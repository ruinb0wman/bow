/**
 * 密码插件(主进程侧):主密码解锁的本地密码库 + 登录页一键填充。
 *
 * 关键约束:普通网页标签**没有 preload**(见 `src/main/tabManager.ts` 的注释),
 * 所以页面侧的一切交互都只能经 `ctx.pages.execute` 注入脚本 —— 下拉脚本的 Promise 会
 * 一直 pending 到用户做出选择(超时上限见 `PICK_TIMEOUT_MS`)。
 *
 * 安全姿态:
 * - 密码只在主进程内存里;只有「填这一条」时,那一份密码才作为注入脚本的一次参数进入页面;
 * - 未解锁时除 `status` / `setup` / `unlock` / 设置读写外一律拒绝;
 * - `fillEntry` 会**二次校验**解锁态与 origin(不信任渲染层传来的 id);
 * - 不做自动提交、不注入常驻脚本、不注册任何 MCP 工具。
 *
 * 设计细节见 `.pi/plans/2026-09-30-password-plugin/plan.md`。
 */

import { clipboard } from 'electron'
import type { TabInfo } from '@shared/types'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import {
  DEFAULT_PASSWORD_SETTINGS,
  entryMatchesOrigin,
  hostOf,
  newId,
  normalizeSettings,
  originOf,
  sortEntries,
  toMeta,
  type PasswordEntry,
  type PasswordSettings
} from './shared'
import {
  EMPTY_VAULT,
  changeMaster,
  createVault,
  isInitialized,
  openEntries,
  reseal,
  unlockVault,
  type VaultFile
} from './vault'
import {
  DETECT_JS,
  READ_FIELDS_JS,
  buildFillScript,
  buildPickerScript,
  type PickerCandidate
} from './scripts'

/** 主密码最短长度(创建 / 修改时校验) */
const MIN_MASTER_LENGTH = 6
/** 一次最多展示多少个候选账号 */
const MAX_CANDIDATES = 20
/** 注入脚本超时 */
const DETECT_TIMEOUT_MS = 5_000
const FILL_TIMEOUT_MS = 8_000
const READ_TIMEOUT_MS = 5_000
/** 页内下拉等待用户选择的上限 */
const PICK_TIMEOUT_MS = 120_000

interface PageProbe {
  ok?: boolean
  url?: string
  title?: string
  hasPassword?: boolean
  hasUsername?: boolean
}

interface ReadFields extends PageProbe {
  username?: string
  password?: string
}

interface FillOutcome {
  ok?: boolean
  filled?: { username?: boolean; password?: boolean }
  error?: string
}

interface PickerOutcome {
  entryId?: string
  cancelled?: boolean
  error?: string
}

interface SaveInput {
  id?: string
  title?: string
  origin?: string
  username?: string
  password?: string | null
  notes?: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createPasswordsPlugin(): PluginMain {
  // 实例级状态(activate / deactivate 共用;重新启用 = 回到锁定态)
  let vaultStore: PluginStorage<VaultFile> | null = null
  let settingsStore: PluginStorage<PasswordSettings> | null = null
  let key: Buffer | null = null
  let entries: PasswordEntry[] = []
  let lockTimer: ReturnType<typeof setTimeout> | null = null
  let clipboardTimer: ReturnType<typeof setTimeout> | null = null
  /** 正在等用户在下拉里选择的标签页(同一时刻只允许一个) */
  let pickerTabId: number | null = null
  let failedUnlocks = 0

  const settings = (): PasswordSettings => normalizeSettings(settingsStore?.get())
  const vault = (): VaultFile => vaultStore?.get() ?? EMPTY_VAULT

  /** 清掉内存里的密钥与条目(不广播;广播由 activate 里的 lock() 包装) */
  function clearKey(): void {
    if (key) {
      key.fill(0)
      key = null
    }
    entries = []
    if (lockTimer) {
      clearTimeout(lockTimer)
      lockTimer = null
    }
    if (clipboardTimer) {
      clearTimeout(clipboardTimer)
      clipboardTimer = null
    }
    pickerTabId = null
  }

  return {
    manifest: {
      id: 'passwords',
      name: '密码',
      description: '主密码解锁的本地密码库:登录页一键填充、生成强密码、剪贴板自动清除',
      version: '1.0.0'
    },
    capabilities: ['ui', 'shortcut'],

    activate(ctx: PluginContext): void {
      vaultStore = ctx.storage<VaultFile>({ file: 'passwords.json', defaults: EMPTY_VAULT })
      settingsStore = ctx.storage<PasswordSettings>({
        file: 'passwords-settings.json',
        defaults: DEFAULT_PASSWORD_SETTINGS
      })

      const emitState = (): void => {
        ctx.ipc.emit('state-changed', {
          initialized: isInitialized(vault()),
          locked: key == null,
          count: entries.length
        })
      }

      const persist = (): void => {
        if (key == null || !vaultStore) return
        vaultStore.setRaw(reseal(vault(), key, entries))
      }

      const touch = (entry: PasswordEntry): void => {
        entry.usedAt = Date.now()
      }

      const armLock = (): void => {
        if (lockTimer) {
          clearTimeout(lockTimer)
          lockTimer = null
        }
        const minutes = settings().autoLockMinutes
        if (key == null || minutes <= 0) return
        lockTimer = setTimeout(() => lock(), minutes * 60_000)
      }

      const lock = (): void => {
        clearKey()
        emitState()
      }

      const openPanel = (payload: Record<string, unknown>): void => {
        ctx.ipc.emit('open-panel', payload)
      }

      const resolveTab = (tabId?: number): TabInfo | null => {
        const id = tabId ?? ctx.pages.activeTabId()
        if (id == null) return ctx.tabs.getActive()
        return ctx.tabs.list().find((t) => t.id === id) ?? null
      }

      /** 把一条凭据填进指定标签页(调用方负责先确认解锁态) */
      const fillByEntry = async (tab: TabInfo, entry: PasswordEntry): Promise<{ ok: boolean; error?: string }> => {
        const origin = originOf(tab.url)
        if (!origin) return { ok: false, error: '当前页面不支持填充(仅 http/https)' }
        if (!entryMatchesOrigin(entry.origin, origin, settings().matchSubdomains)) {
          return { ok: false, error: '该条目与当前站点不匹配' }
        }
        let raw: unknown
        try {
          raw = await ctx.pages.execute(
            tab.id,
            buildFillScript({ username: entry.username, password: entry.password }),
            { timeoutMs: FILL_TIMEOUT_MS }
          )
        } catch (e) {
          return { ok: false, error: '页面脚本执行失败:' + msg(e) }
        }
        const res = (raw ?? {}) as FillOutcome
        if (res.ok === false) return { ok: false, error: res.error ?? '填充失败' }
        touch(entry)
        persist()
        return { ok: true }
      }

      /** 按钮 / Ctrl+Shift+P 的主流程 */
      const beginFill = async (tabId?: number): Promise<Record<string, unknown>> => {
        if (pickerTabId != null) return { ok: false, mode: 'busy' }
        const tab = resolveTab(tabId)
        if (!tab) return { ok: false, mode: 'no-tab' }
        const origin = originOf(tab.url)
        if (!origin) return { ok: false, mode: 'unsupported' }
        if (!isInitialized(vault())) {
          openPanel({ mode: 'setup' })
          return { ok: false, mode: 'setup' }
        }
        if (key == null) {
          openPanel({ mode: 'unlock' })
          return { ok: false, mode: 'locked' }
        }

        let probe: PageProbe
        try {
          probe = ((await ctx.pages.execute(tab.id, DETECT_JS, { timeoutMs: DETECT_TIMEOUT_MS })) ??
            {}) as PageProbe
        } catch (e) {
          return { ok: false, mode: 'error', error: '探测当前页面失败:' + msg(e) }
        }
        if (!probe.hasPassword && !probe.hasUsername) {
          openPanel({ mode: 'save', tabId: tab.id })
          return { ok: false, mode: 'no-form' }
        }

        const matched = sortEntries(
          entries.filter((e) => entryMatchesOrigin(e.origin, origin, settings().matchSubdomains))
        )
        if (matched.length === 0) {
          openPanel({ mode: 'save', tabId: tab.id })
          return { ok: false, mode: 'no-match' }
        }
        if (matched.length === 1) {
          const r = await fillByEntry(tab, matched[0])
          return r.ok ? { ok: true, mode: 'filled' } : { ok: false, mode: 'error', error: r.error }
        }

        // 多条匹配 → 页内下拉(只送用户名),等用户选
        pickerTabId = tab.id
        try {
          const candidates: PickerCandidate[] = matched.slice(0, MAX_CANDIDATES).map((e) => ({
            id: e.id,
            title: e.title,
            username: e.username
          }))
          const raw: unknown = await ctx.pages.execute(tab.id, buildPickerScript(candidates), {
            timeoutMs: PICK_TIMEOUT_MS
          })
          const res = (raw ?? {}) as PickerOutcome
          if (res.error) return { ok: false, mode: 'error', error: res.error === 'no-field' ? '页面上找不到可填充的字段' : res.error }
          if (!res.entryId) return { ok: false, mode: 'cancelled' }
          // 等用户这几十秒里可能触发自动锁定:填之前再确认一次
          if (key == null) {
            openPanel({ mode: 'unlock' })
            return { ok: false, mode: 'locked' }
          }
          const entry = entries.find((e) => e.id === res.entryId)
          if (!entry) return { ok: false, mode: 'error', error: '条目已不存在' }
          const r = await fillByEntry(tab, entry)
          return r.ok ? { ok: true, mode: 'picked' } : { ok: false, mode: 'error', error: r.error }
        } catch (e) {
          return { ok: false, mode: 'error', error: '等待选择超时或页面已离开:' + msg(e) }
        } finally {
          if (pickerTabId === tab.id) pickerTabId = null
        }
      }

      // ---------- IPC ----------

      ctx.ipc.handle('status', () => ({
        ok: true,
        initialized: isInitialized(vault()),
        locked: key == null,
        count: entries.length,
        settings: settings()
      }))

      ctx.ipc.handle('setup', (master: unknown) => {
        if (isInitialized(vault())) return { ok: false, error: '密码库已存在' }
        const value = str(master)
        if (value.length < MIN_MASTER_LENGTH) {
          return { ok: false, error: `主密码至少 ${MIN_MASTER_LENGTH} 个字符` }
        }
        const created = createVault(value, [])
        vaultStore!.setRaw(created.file)
        clearKey()
        key = created.key
        failedUnlocks = 0
        armLock()
        emitState()
        return { ok: true }
      })

      ctx.ipc.handle('unlock', async (master: unknown) => {
        const file = vault()
        if (!isInitialized(file)) return { ok: false, error: '尚未创建主密码' }
        // 连续失败退避(上限 30s):scrypt 本身慢,再加一层挡住本地脚本硬试
        if (failedUnlocks >= 5) await sleep(Math.min(30_000, 1_000 * 2 ** (failedUnlocks - 5)))
        const derived = unlockVault(file, str(master))
        if (!derived) {
          failedUnlocks++
          return { ok: false, error: '主密码不正确或密码库已损坏' }
        }
        let parsed: PasswordEntry[]
        try {
          parsed = openEntries(derived, file)
        } catch (e) {
          derived.fill(0)
          return { ok: false, error: '密码库解密失败(文件可能已损坏):' + msg(e) }
        }
        clearKey()
        key = derived
        entries = parsed
        failedUnlocks = 0
        armLock()
        emitState()
        return { ok: true }
      })

      ctx.ipc.handle('lock', () => {
        lock()
        return { ok: true }
      })

      ctx.ipc.handle('list', () => {
        if (key == null) return { ok: false, error: '密码库已锁定' }
        return { ok: true, entries: sortEntries(entries).map(toMeta) }
      })

      ctx.ipc.handle('getEntry', (id: unknown) => {
        if (key == null) return { ok: false, error: '密码库已锁定' }
        const entry = entries.find((e) => e.id === id)
        if (!entry) return { ok: false, error: '条目不存在' }
        return { ok: true, entry }
      })

      ctx.ipc.handle('save', (raw: unknown) => {
        if (key == null) return { ok: false, error: '密码库已锁定' }
        const input = (raw && typeof raw === 'object' ? raw : {}) as SaveInput
        const origin = originOf(str(input.origin))
        if (!origin) return { ok: false, error: '站点地址无效(需要 http/https 地址)' }
        const now = Date.now()
        if (input.id) {
          const index = entries.findIndex((e) => e.id === input.id)
          if (index < 0) return { ok: false, error: '条目不存在' }
          const prev = entries[index]
          const next: PasswordEntry = {
            ...prev,
            title: str(input.title) || prev.title,
            origin,
            username: str(input.username),
            password: typeof input.password === 'string' ? input.password : prev.password,
            updatedAt: now
          }
          if (typeof input.notes === 'string') {
            if (input.notes) next.notes = input.notes
            else delete next.notes
          }
          entries[index] = next
        } else {
          const entry: PasswordEntry = {
            id: newId(),
            title: str(input.title) || hostOf(origin) || origin,
            origin,
            username: str(input.username),
            password: str(input.password),
            createdAt: now,
            updatedAt: now
          }
          const notes = str(input.notes)
          if (notes) entry.notes = notes
          entries.push(entry)
        }
        persist()
        armLock()
        emitState()
        return { ok: true }
      })

      ctx.ipc.handle('remove', (id: unknown) => {
        if (key == null) return { ok: false, error: '密码库已锁定' }
        const before = entries.length
        entries = entries.filter((e) => e.id !== id)
        if (entries.length === before) return { ok: false, error: '条目不存在' }
        persist()
        emitState()
        return { ok: true }
      })

      ctx.ipc.handle('copy', async (id: unknown, field: unknown) => {
        if (key == null) return { ok: false, error: '密码库已锁定' }
        const entry = entries.find((e) => e.id === id)
        if (!entry) return { ok: false, error: '条目不存在' }
        const what = field === 'username' ? 'username' : 'password'
        const secret = what === 'username' ? entry.username : entry.password
        if (!secret) return { ok: false, error: what === 'username' ? '这条没有用户名' : '这条没有密码' }
        // Electron 的剪贴板 API 是 Promise 型的(W3C 风格)
        await clipboard.writeText(secret)
        const seconds = settings().clipboardClearSeconds
        if (clipboardTimer) {
          clearTimeout(clipboardTimer)
          clipboardTimer = null
        }
        if (what === 'password' && seconds > 0) {
          clipboardTimer = setTimeout(() => {
            clipboardTimer = null
            void (async () => {
              try {
                // 用户已经复制了别的东西就不覆盖
                if ((await clipboard.readText()) === secret) clipboard.clear()
              } catch {
                // 剪贴板不可用:忽略
              }
            })()
          }, seconds * 1000)
        }
        touch(entry)
        persist()
        return { ok: true, clearsIn: what === 'password' ? seconds : 0 }
      })

      ctx.ipc.handle('readPageFields', async (tabId?: number) => {
        const tab = resolveTab(tabId)
        if (!tab) return { ok: false, error: '没有可用的标签页' }
        const origin = originOf(tab.url)
        if (!origin) return { ok: false, error: '当前页面不支持(仅 http/https)' }
        let raw: unknown
        try {
          raw = await ctx.pages.execute(tab.id, READ_FIELDS_JS, { timeoutMs: READ_TIMEOUT_MS })
        } catch (e) {
          return { ok: false, error: '读取当前页面失败:' + msg(e) }
        }
        const res = (raw ?? {}) as ReadFields
        if (res.ok === false) return { ok: false, error: '读取当前页面字段失败' }
        return {
          ok: true,
          tabId: tab.id,
          url: res.url ?? tab.url,
          title: res.title ?? '',
          origin,
          hasPassword: !!res.hasPassword,
          username: str(res.username),
          password: str(res.password)
        }
      })

      ctx.ipc.handle('fillEntry', async (id: unknown, tabId?: number) => {
        if (key == null) return { ok: false, error: '密码库已锁定' }
        const tab = resolveTab(tabId)
        if (!tab) return { ok: false, error: '没有可用的标签页' }
        const entry = entries.find((e) => e.id === id)
        if (!entry) return { ok: false, error: '条目不存在' }
        const r = await fillByEntry(tab, entry)
        armLock()
        return r.ok ? { ok: true } : { ok: false, error: r.error }
      })

      ctx.ipc.handle('beginFill', (tabId?: number) => beginFill(tabId))

      ctx.ipc.handle('changeMaster', (oldMaster: unknown, newMaster: unknown) => {
        if (key == null) return { ok: false, error: '密码库已锁定' }
        const oldKey = unlockVault(vault(), str(oldMaster))
        if (!oldKey) return { ok: false, error: '旧主密码不正确' }
        oldKey.fill(0)
        const next = str(newMaster)
        if (next.length < MIN_MASTER_LENGTH) {
          return { ok: false, error: `新主密码至少 ${MIN_MASTER_LENGTH} 个字符` }
        }
        const created = changeMaster(entries, next)
        vaultStore!.setRaw(created.file)
        if (key) key.fill(0)
        key = created.key
        armLock()
        emitState()
        return { ok: true }
      })

      ctx.ipc.handle('getSettings', () => settings())

      ctx.ipc.handle('setSettings', (patch: unknown) => {
        const next = normalizeSettings({ ...settings(), ...(patch && typeof patch === 'object' ? patch : {}) })
        settingsStore!.setRaw(next)
        ctx.ipc.emit('settings-changed', next)
        armLock()
        return next
      })

      ctx.ipc.handle('wipe', () => {
        vaultStore!.setRaw({ ...EMPTY_VAULT })
        clearKey()
        failedUnlocks = 0
        emitState()
        return { ok: true }
      })

      // ---------- 快捷键与标签事件 ----------

      ctx.shortcuts.register({ key: 'p', code: 'KeyP', ctrl: true, shift: true }, () => {
        void beginFill()
      })

      ctx.events.on('tab:navigated', (p: { tabId: number }) => {
        if (pickerTabId === p.tabId) pickerTabId = null
      })
      ctx.events.on('tab:closed', (p: { id: number }) => {
        if (pickerTabId === p.id) pickerTabId = null
      })
    },

    deactivate(): void {
      clearKey()
    }
  }
}

const passwordsPlugin = createPasswordsPlugin()
export default passwordsPlugin
