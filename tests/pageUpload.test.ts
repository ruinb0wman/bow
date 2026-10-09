/**
 * 把本地文件塞进网页 `<input type=file>` 的核心实现(`main/pageUpload.ts`)。
 *
 * 这一组钉的是 **CDP 命令序列**与几条容易搞错的分支:自己挂的调试器才 detach、
 * DevTools 占着时明确失败、多个输入框要报候选而不是猜、非 multiple 的框不能塞多个。
 *
 * 用 `tests/fakeWc.ts` 的假 WebContents(它的假调试器已支持 DOM.* 与 upload 读回)。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { FakeWc } from './fakeWc'
import { uploadFilesToPage } from '../src/main/pageUpload'
import type { WebContents } from 'electron'

let wc: FakeWc
const wcOf = (): WebContents => wc as unknown as WebContents

const methods = (): string[] => wc.debugger.calls.map((c) => c.method)

beforeEach(() => {
  wc = new FakeWc()
  wc.debugger.fileInputNodeIds = [7]
  wc.debugger.nodeAttributes.set(7, ['type', 'file', 'multiple', ''])
  wc.debugger.uploadState = { multiple: true, accept: '', files: [{ name: 'a.txt', size: 3, type: 'text/plain' }] }
})

describe('uploadFilesToPage', () => {
  it('唯一一个输入框:走 querySelectorAll → describeNode → setFileInputFiles,并读回页面侧 files', async () => {
    const result = await uploadFilesToPage(wcOf(), { files: ['/tmp/a.txt'] })
    expect(result.ok).toBe(true)
    expect(result.input?.files).toEqual([{ name: 'a.txt', size: 3, type: 'text/plain' }])
    expect(methods()).toEqual([
      'DOM.enable',
      'DOM.getDocument',
      'DOM.querySelectorAll',
      'DOM.describeNode',
      'DOM.setFileInputFiles',
      'Runtime.evaluate'
    ])
    const set = wc.debugger.calls.find((c) => c.method === 'DOM.setFileInputFiles')?.params as {
      nodeId: number
      files: string[]
    }
    expect(set).toEqual({ nodeId: 7, files: ['/tmp/a.txt'] })
  })

  it('临时挂的调试器用完要 detach;别人挂着的复用、绝不 detach', async () => {
    await uploadFilesToPage(wcOf(), { files: ['/tmp/a.txt'] })
    expect(wc.debugger.attached).toBe(false)
    expect(wc.debugger.detachCount).toBe(1)

    wc.debugger.calls.length = 0
    wc.debugger.attached = true // 模拟整页截图 / DevTools 已经挂着
    const reused = await uploadFilesToPage(wcOf(), { files: ['/tmp/a.txt'] })
    expect(reused.ok).toBe(true)
    expect(wc.debugger.attached).toBe(true)
    expect(wc.debugger.detachCount).toBe(1)
  })

  it('DevTools 占着调试器 → 明确失败并标记 debuggerBusy(不去抢)', async () => {
    wc.debugger.attachError = new Error('Another debugger is already attached')
    const result = await uploadFilesToPage(wcOf(), { files: ['/tmp/a.txt'] })
    expect(result.ok).toBe(false)
    expect(result.debuggerBusy).toBe(true)
    expect(result.error).toContain('DevTools')
    expect(methods()).toEqual([])
  })

  it('给了 selector 就按它查(不走 querySelectorAll),并在读回时也用同一个选择器', async () => {
    wc.debugger.queryNodeId = 9
    const result = await uploadFilesToPage(wcOf(), { files: ['/tmp/a.txt'], selector: '#upload' })
    expect(result.ok).toBe(true)
    expect(methods()).toEqual([
      'DOM.enable',
      'DOM.getDocument',
      'DOM.querySelector',
      'DOM.describeNode',
      'DOM.setFileInputFiles',
      'Runtime.evaluate'
    ])
    expect(wc.debugger.calls[2]?.params).toEqual({ nodeId: 1, selector: '#upload' })
  })

  it('selector 匹配不到 → 报出来(不静默去猜别的输入框)', async () => {
    wc.debugger.queryNodeId = 0
    const result = await uploadFilesToPage(wcOf(), { files: ['/tmp/a.txt'], selector: '#nope' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('#nope')
    expect(methods()).not.toContain('DOM.setFileInputFiles')
  })

  it('页面上一个输入框都没有 → 报错并提示「可能是点按钮才出现」', async () => {
    wc.debugger.fileInputNodeIds = []
    const result = await uploadFilesToPage(wcOf(), { files: ['/tmp/a.txt'] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('browser_click')
    expect(methods()).not.toContain('DOM.setFileInputFiles')
  })

  it('多个输入框 → 报候选清单(带 id/name/accept/multiple),让调用方自己挑', async () => {
    wc.debugger.fileInputNodeIds = [7, 8]
    wc.debugger.nodeAttributes.set(7, ['id', 'avatar', 'accept', 'image/*'])
    wc.debugger.nodeAttributes.set(8, ['name', 'resume', 'multiple', ''])
    const result = await uploadFilesToPage(wcOf(), { files: ['/tmp/a.txt'] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('2 个文件输入框')
    expect(result.candidates).toEqual([
      { index: 0, id: 'avatar', accept: 'image/*', multiple: false, disabled: false },
      { index: 1, name: 'resume', multiple: true, disabled: false }
    ])
    expect(methods()).not.toContain('DOM.setFileInputFiles')
  })

  it('单选的输入框塞多个文件 → 下发之前就拒绝', async () => {
    wc.debugger.nodeAttributes.set(7, ['type', 'file'])
    const result = await uploadFilesToPage(wcOf(), { files: ['/tmp/a.txt', '/tmp/b.txt'] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('multiple')
    expect(methods()).not.toContain('DOM.setFileInputFiles')
  })

  it('下发之后输入框里还是空的 → 算失败(页面可能立刻清空了)', async () => {
    wc.debugger.uploadState = { multiple: true, accept: '', files: [] }
    const result = await uploadFilesToPage(wcOf(), { files: ['/tmp/a.txt'] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('仍然是空的')
  })

  it('CDP 报错(文件不存在等)原样带回来,且仍然 detach', async () => {
    wc.debugger.sendError = new Error('File not found')
    const result = await uploadFilesToPage(wcOf(), { files: ['/tmp/gone.txt'] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('File not found')
    expect(wc.debugger.attached).toBe(false)
    expect(wc.debugger.detachCount).toBe(1)
  })

  it('空文件列表 / 已关闭的标签 → 直接拒绝,不碰调试器', async () => {
    expect((await uploadFilesToPage(wcOf(), { files: [] })).ok).toBe(false)
    expect((await uploadFilesToPage(wcOf(), { files: ['  '] })).ok).toBe(false)
    wc.destroyed = true
    expect((await uploadFilesToPage(wcOf(), { files: ['/tmp/a.txt'] })).ok).toBe(false)
    expect(methods()).toEqual([])
  })
})
