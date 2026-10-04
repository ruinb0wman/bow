/**
 * `activateAgentTab`:点系统通知 = 进入对应标签。这是唯一实现,
 * 所以这几步(切标签 / 标记活动窗口 / 补页面 focus / 提窗口)每一条都要钉住。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0' } }))

const { activateAgentTab } = await import('../src/main/agentActivate')
type AgentActivateDeps = Parameters<typeof activateAgentTab>[0]

interface Calls {
  markActive: number
  activate: number[]
  viewFocus: number
  restore: number
  show: number
  windowFocus: number
}

function setup(opts: { minimized?: boolean; destroyed?: boolean } = {}) {
  const calls: Calls = { markActive: 0, activate: [], viewFocus: 0, restore: 0, show: 0, windowFocus: 0 }
  const ctx = {
    window: {
      isMinimized: () => opts.minimized === true,
      restore: () => {
        calls.restore += 1
      },
      show: () => {
        calls.show += 1
      },
      focus: () => {
        calls.windowFocus += 1
      }
    },
    tabs: {
      activate: (tabId: number) => {
        calls.activate.push(tabId)
      }
    }
  }
  const record = {
    view: {
      webContents: {
        isDestroyed: () => opts.destroyed === true,
        focus: () => {
          calls.viewFocus += 1
        }
      }
    }
  }
  const deps = {
    byTabId: (tabId: number) => (tabId === 5 ? { ctx, record } : null),
    markActive: () => {
      calls.markActive += 1
    }
  } as unknown as AgentActivateDeps
  return { deps, calls }
}

describe('activateAgentTab', () => {
  it('找到标签:标记活动窗口 + 切标签 + 补页面 focus + 提窗口', () => {
    const { deps, calls } = setup()
    expect(activateAgentTab(deps, 5)).toBe(true)
    expect(calls.markActive).toBe(1)
    expect(calls.activate).toEqual([5])
    expect(calls.viewFocus).toBe(1)
    expect(calls.restore).toBe(0)
    expect(calls.show).toBe(1)
    expect(calls.windowFocus).toBe(1)
  })

  it('窗口最小化时先 restore', () => {
    const { deps, calls } = setup({ minimized: true })
    activateAgentTab(deps, 5)
    expect(calls.restore).toBe(1)
    expect(calls.show).toBe(1)
  })

  it('页面视图已销毁:跳过 focus,其余照做', () => {
    const { deps, calls } = setup({ destroyed: true })
    expect(activateAgentTab(deps, 5)).toBe(true)
    expect(calls.viewFocus).toBe(0)
    expect(calls.activate).toEqual([5])
  })

  it('标签已经关了:返回 false,什么都不碰', () => {
    const { deps, calls } = setup()
    expect(activateAgentTab(deps, 999)).toBe(false)
    expect(calls).toEqual({ markActive: 0, activate: [], viewFocus: 0, restore: 0, show: 0, windowFocus: 0 })
  })
})
