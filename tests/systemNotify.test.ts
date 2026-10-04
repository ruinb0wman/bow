/**
 * 系统通知的 Electron 薄壳:只钉住「构造参数 / click 接线 / 撤回 / 失败不上抛」这四件事,
 * 以及 `BOW_NOTIFY_LOG` 测试缝(JSONL 行 + `__bowNotifyClick` 全局)。
 *
 * Electron 的 `Notification` 用假类替掉(与 `tests/pomoPlugin.test.ts` 同一手法);
 * 通知的**时机**在 `tests/agentNotify.test.ts` 钉。
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  shown: [] as Array<{ title: string; body?: string; silent?: boolean }>,
  closed: 0,
  clicks: [] as Array<() => void>,
  supported: true,
  throws: false
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
  Notification: class MockNotification {
    constructor(private readonly opts: { title: string; body?: string; silent?: boolean }) {
      if (h.throws) throw new Error('notification boom')
    }
    static isSupported(): boolean {
      return h.supported
    }
    on(_event: string, cb: () => void): this {
      h.clicks.push(cb)
      return this
    }
    show(): void {
      h.shown.push(this.opts)
    }
    close(): void {
      h.closed += 1
    }
  }
}))

const { createSystemNotifier } = await import('../src/main/systemNotify')

const logFile = join(tmpdir(), `bow-systemnotify-${process.pid}.jsonl`)

beforeEach(() => {
  h.shown = []
  h.closed = 0
  h.clicks = []
  h.supported = true
  h.throws = false
  rmSync(logFile, { force: true })
})

afterEach(() => {
  rmSync(logFile, { force: true })
  delete (globalThis as Record<string, unknown>).__bowNotifyClick
})

describe('createSystemNotifier', () => {
  it('用静音的 title/body 发通知;点它 → 进入对应标签', () => {
    const activated: number[] = []
    const notifier = createSystemNotifier({ activate: (tabId) => activated.push(tabId) })
    const handle = notifier.show({ kind: 'blocked', title: 'pi 需要确认', body: '切换到 build？', tabId: 7 })

    expect(h.shown).toEqual([{ title: 'pi 需要确认', body: '切换到 build？', silent: true }])
    h.clicks.forEach((cb) => cb())
    expect(activated).toEqual([7])

    handle.close()
    expect(h.closed).toBe(1)
  })

  it('平台不支持 → 不发也不抛', () => {
    h.supported = false
    const notifier = createSystemNotifier({ activate: () => {} })
    const handle = notifier.show({ kind: 'done', title: 'pi 已完成', tabId: 1 })
    expect(h.shown).toEqual([])
    expect(() => handle.close()).not.toThrow()
  })

  it('构造抛错 → 记日志并返回空句柄,不上抛', () => {
    h.throws = true
    const notifier = createSystemNotifier({ activate: () => {} })
    let handle: import('../src/main/systemNotify').NoticeHandle | null = null
    expect(() => {
      handle = notifier.show({ kind: 'done', title: 'pi 已完成', tabId: 1 })
    }).not.toThrow()
    expect(() => handle!.close()).not.toThrow()
  })

  it('BOW_NOTIFY_LOG:show/close 各追加一行 JSONL,并挂上 __bowNotifyClick', () => {
    const activated: number[] = []
    const notifier = createSystemNotifier({ activate: (tabId) => activated.push(tabId), logPath: logFile })
    const handle = notifier.show({ kind: 'blocked', title: 'pi 需要确认', body: '确认', tabId: 42 })
    handle.close()

    const lines = readFileSync(logFile, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map((l) => l.event)).toEqual(['show', 'close'])
    expect(lines[0]).toMatchObject({ kind: 'blocked', title: 'pi 需要确认', body: '确认', tabId: 42, supported: true })

    // OS 级点击合成不了,E2E 靠这个全局驱动同一条 click 回调
    const hook = (globalThis as Record<string, unknown>).__bowNotifyClick as (tabId: unknown) => void
    hook('42')
    expect(activated).toEqual([42])
  })

  it('不设 BOW_NOTIFY_LOG 时不写文件、不挂全局(生产路径干净)', () => {
    const notifier = createSystemNotifier({ activate: () => {} })
    notifier.show({ kind: 'done', title: 'pi 已完成', tabId: 1 })
    expect(existsSync(logFile)).toBe(false)
    expect((globalThis as Record<string, unknown>).__bowNotifyClick).toBeUndefined()
  })
})
