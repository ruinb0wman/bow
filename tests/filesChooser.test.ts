/**
 * 「接管网站文件选择框」的决策层(`plugins/files/chooser.ts`)。
 *
 * 这一组钉的是状态机而不是 CDP(CDP 那半边由真机验证看住):
 * 挂过的标签页要记账、关开关要全部收回、一次只攒一个请求、超时/取消要通知渲染层收面板、
 * 应答失败时**不能**把请求丢掉(用户还要重试)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createChooserController, type ChooserDeps } from '../src/plugins/files/chooser'
import type { FileChooserOpenedInfo } from '../src/main/pageUpload'
import type { PluginPageApi } from '../src/main/plugins/types'

interface ArmRecord {
  tabId: number
  hooks: { onOpened(info: FileChooserOpenedInfo): void; onLost(reason: string): void }
}

let armed: ArmRecord[]
let disarmed: number[]
let answered: Array<{ tabId: number; backendNodeId: number; files: string[] }>
let answerResult: { ok: boolean; error?: string }
let probeResult: boolean
let guardResult: { ok: true; abs: string[] } | { ok: false; error: string }
let opened: Array<{ mode: string; tabId: number; multiple: boolean }>
let resolved: number[]
let clock: number
let deps: ChooserDeps

function pages(): PluginPageApi {
  return {
    activeTabId: () => null,
    focus: () => {},
    execute: async () => ({}),
    uploadFiles: async () => ({ ok: true }),
    openDevToolsTab: () => 0,
    fileChooser: {
      arm: async (tabId, hooks) => {
        armed.push({ tabId, hooks })
        return { ok: true, already: false }
      },
      disarm: (tabId) => {
        disarmed.push(tabId)
      },
      armed: (tabId) => armed.some((a) => a.tabId === tabId),
      answer: async (tabId, opts) => {
        answered.push({ tabId, backendNodeId: opts.backendNodeId, files: opts.files })
        return answerResult
      }
    }
  }
}

function make(opts: { enabled?: boolean } = {}) {
  const controller = createChooserController(deps)
  if (opts.enabled !== false) controller.setEnabled(true)
  return controller
}

beforeEach(() => {
  armed = []
  disarmed = []
  answered = []
  answerResult = { ok: true }
  probeResult = true
  guardResult = { ok: true, abs: ['/work/a.txt'] }
  opened = []
  resolved = []
  clock = 1_000
  deps = {
    pages: pages(),
    probe: async () => probeResult,
    guardFiles: async () => guardResult,
    openPanel: (payload) => opened.push(payload),
    notifyResolved: (tabId) => resolved.push(tabId),
    log: () => {},
    now: () => clock,
    ttlMs: 1000
  }
})

describe('挂 / 收', () => {
  it('页面里有 file input 才挂;同一个标签只挂一次', async () => {
    const chooser = make()
    await chooser.evaluate(7)
    expect(armed.map((a) => a.tabId)).toEqual([7])
    expect(chooser.status().armedTabs).toEqual([7])

    await chooser.evaluate(7)
    expect(armed).toHaveLength(1)
  })

  it('页面里没有 file input → 不挂;原本挂着的要收回来', async () => {
    const chooser = make()
    await chooser.evaluate(7)
    probeResult = false
    await chooser.evaluate(7)
    expect(armed).toHaveLength(1)
    expect(disarmed).toEqual([7])
    expect(chooser.status().armedTabs).toEqual([])
  })

  it('开关关着时 evaluate 什么也不做', async () => {
    const chooser = make({ enabled: false })
    await chooser.evaluate(7)
    expect(armed).toEqual([])
  })

  it('关掉开关:已挂的全部收回,并丢掉攒着的请求', async () => {
    const chooser = make()
    await chooser.evaluate(7)
    armed[0]?.hooks.onOpened({ mode: 'selectSingle', backendNodeId: 3 })
    expect(chooser.status().pending).not.toBeNull()

    chooser.setEnabled(false)
    expect(disarmed).toEqual([7])
    expect(chooser.status().armedTabs).toEqual([])
    expect(chooser.status().pending).toBeNull()
    expect(resolved).toContain(7)
  })

  it('标签页关闭:收回记账 + 丢掉它的请求', async () => {
    const chooser = make()
    await chooser.evaluate(7)
    armed[0]?.hooks.onOpened({ mode: 'selectSingle', backendNodeId: 3 })
    chooser.onClosed(7)
    expect(chooser.status().armedTabs).toEqual([])
    expect(chooser.status().pending).toBeNull()
  })

  it('接管被终止(DevTools 抢走):记账清掉 + 丢掉请求,且不自动重挂', async () => {
    const chooser = make()
    await chooser.evaluate(7)
    armed[0]?.hooks.onOpened({ mode: 'selectSingle', backendNodeId: 3 })
    armed[0]?.hooks.onLost('DevTools was opened')
    expect(chooser.status().armedTabs).toEqual([])
    expect(chooser.status().pending).toBeNull()
    expect(armed).toHaveLength(1) // 没有第二次 arm
  })

  it('手动接管:不翻设置开关,但确实挂上了', async () => {
    const chooser = make({ enabled: false })
    expect(await chooser.armNow(9)).toEqual({ ok: true })
    expect(chooser.status().armedTabs).toEqual([9])
    expect(chooser.status().enabled).toBe(false)
  })
})

describe('攒请求 / 应答', () => {
  async function withPending(chooser: ReturnType<typeof make>, tabId = 7) {
    await chooser.evaluate(tabId)
    armed.find((a) => a.tabId === tabId)?.hooks.onOpened({ mode: 'selectMultiple', backendNodeId: 42 })
  }

  it('onOpened 攒下请求(带 mode/multiple)并请面板打开', async () => {
    const chooser = make()
    await withPending(chooser)
    expect(chooser.status().pending).toMatchObject({ tabId: 7, backendNodeId: 42, mode: 'selectMultiple', multiple: true })
    expect(opened).toEqual([{ mode: 'pick-upload', tabId: 7, multiple: true }])
  })

  it('单选模式 multiple 为 false', async () => {
    const chooser = make()
    await chooser.evaluate(7)
    armed[0]?.hooks.onOpened({ mode: 'selectSingle', backendNodeId: 5 })
    expect(chooser.status().pending?.multiple).toBe(false)
    expect(opened[0]?.multiple).toBe(false)
  })

  it('pendingFor:给了 tabId 要精确匹配;没给则只在全局唯一时认', async () => {
    const chooser = make()
    await withPending(chooser, 7)
    expect(chooser.pendingFor(7)?.backendNodeId).toBe(42)
    expect(chooser.pendingFor(8)).toBeNull()
    expect(chooser.pendingFor()?.backendNodeId).toBe(42)
  })

  it('超时(默认 45s,这里注入 1s)后按没发生处理,并通知渲染层收面板', async () => {
    const chooser = make()
    await withPending(chooser)
    clock += 1001
    expect(chooser.status().pending).toBeNull()
    expect(resolved).toEqual([7])
    expect(chooser.pendingFor()).toBeNull()
  })

  it('应答:过白名单 → 调核心 answer(带 backendNodeId)→ 清请求 + 通知收面板', async () => {
    const chooser = make()
    await withPending(chooser)
    const result = await chooser.answer(['/work/a.txt'], 7)
    expect(result?.ok).toBe(true)
    expect(answered).toEqual([{ tabId: 7, backendNodeId: 42, files: ['/work/a.txt'] }])
    expect(chooser.status().pending).toBeNull()
    expect(resolved).toEqual([7])
  })

  it('没有待处理请求时 answer 返回 null(调用方走「直接塞」那条路)', async () => {
    const chooser = make()
    expect(await chooser.answer(['/work/a.txt'])).toBeNull()
    expect(answered).toEqual([])
  })

  it('白名单不过 → 拒绝,但**留着**这次请求让人重试', async () => {
    const chooser = make()
    await withPending(chooser)
    guardResult = { ok: false, error: '路径不在允许的工作目录内' }
    const result = await chooser.answer(['/etc/passwd'], 7)
    expect(result).toMatchObject({ ok: false, error: '路径不在允许的工作目录内' })
    expect(answered).toEqual([])
    expect(chooser.status().pending).not.toBeNull()
  })

  it('核心应答失败 → 留着请求(选择框还处于被接管状态,可以重试)', async () => {
    const chooser = make()
    await withPending(chooser)
    answerResult = { ok: false, error: '标签页已关闭' }
    const result = await chooser.answer(['/work/a.txt'], 7)
    expect(result).toMatchObject({ ok: false, error: '标签页已关闭' })
    expect(chooser.status().pending).not.toBeNull()
  })

  it('cancel:丢掉请求并通知收面板', async () => {
    const chooser = make()
    await withPending(chooser)
    chooser.cancel()
    expect(chooser.status().pending).toBeNull()
    expect(resolved).toEqual([7])
  })

  it('后来者覆盖前者:同一个标签连点两下只留最后一个请求', async () => {
    const chooser = make()
    await withPending(chooser)
    armed[0]?.hooks.onOpened({ mode: 'selectSingle', backendNodeId: 99 })
    expect(chooser.status().pending?.backendNodeId).toBe(99)
    expect(opened).toHaveLength(2)
  })
})

describe('guardFiles 的调用', () => {
  it('把原始入参原样交给 guardFiles(白名单判定只有一份)', async () => {
    const spy = vi.fn(async () => ({ ok: true as const, abs: ['/work/b.txt'] }))
    deps.guardFiles = spy
    const chooser = make()
    await chooser.evaluate(7)
    armed[0]?.hooks.onOpened({ mode: 'selectSingle', backendNodeId: 1 })
    await chooser.answer(['raw/path.txt'], 7)
    expect(spy).toHaveBeenCalledWith(['raw/path.txt'])
    expect(answered[0]?.files).toEqual(['/work/b.txt'])
  })
})
