/**
 * 夸克注入脚本用例。
 *
 * vitest 跑在 node 环境(无 jsdom),所以这里:
 * - 用 `new Function(...)` 验语法(与 adblock / element-fullscreen 的脚本测试同一手法);
 * - 把 `WALK_FN_SRC` **单独取出来**喂假 fiber 对象验行为 —— 这是本插件最容易随页面改版失效的一段,
 *   必须能在不打开夸克页面的情况下回归;
 * - 对 `EXTRACT_JS` 只做「不变式」文本断言(不写页面、失败必带 diagnostics)。
 */

import { describe, expect, it } from 'vitest'
import { EXTRACT_JS, WALK_FN_SRC } from '../src/plugins/quark/scripts'

type WalkFn = (fiber: unknown) => { props: { list: unknown[] }; depth: number } | null

/** 把源码字符串还原成可调用的函数(与页面里内联的是同一份实现) */
function loadWalk(): WalkFn {
  return new Function(`return ${WALK_FN_SRC}`)() as WalkFn
}

/** 造一条 fiber 链:`return` 指向上游 */
function fiberNode(init: Record<string, unknown>): Record<string, unknown> {
  return { stateNode: undefined, memoizedProps: undefined, return: null, ...init }
}

function chain(...nodes: Array<Record<string, unknown>>): Record<string, unknown> {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].return = nodes[i + 1]
  return nodes[0]
}

describe('夸克注入脚本:WALK_FN_SRC(React fiber 遍历)', () => {
  it('命中 stateNode.props.list', () => {
    const list = [{ fid: 'a' }]
    const root = chain(
      fiberNode({ memoizedProps: { className: 'file-list' } }),
      fiberNode({ stateNode: { props: { list, stoken: 's' } } })
    )
    const found = loadWalk()(root)
    expect(found?.props.list).toBe(list)
    expect(found?.depth).toBe(2)
  })

  it('stateNode 没有 props 时退回 memoizedProps', () => {
    const list = [{ fid: 'b' }]
    const root = fiberNode({ memoizedProps: { list } })
    const found = loadWalk()(root)
    expect(found?.props.list).toBe(list)
    expect(found?.depth).toBe(1)
  })

  it('优先用 stateNode.props(与 LinkSwift 的 findReact 同序)', () => {
    const inner = [{ fid: 'inner' }]
    const outer = [{ fid: 'outer' }]
    const root = fiberNode({
      stateNode: { props: { list: inner } },
      memoizedProps: { list: outer }
    })
    expect(loadWalk()(root)?.props.list).toBe(inner)
  })

  it('一路到顶都没有 list → null(不抛)', () => {
    const root = chain(fiberNode({ memoizedProps: {} }), fiberNode({ memoizedProps: { list: 'not-array' } }), fiberNode({}))
    expect(loadWalk()(root)).toBeNull()
  })

  it('list 不是数组(字符串/对象/null)一律不算命中', () => {
    for (const list of ['abc', {}, null, undefined, 42]) {
      expect(loadWalk()(fiberNode({ memoizedProps: { list } })), JSON.stringify(list)).toBeNull()
    }
  })

  it('坏输入不抛:null / 非对象 / 自环', () => {
    expect(loadWalk()(null)).toBeNull()
    expect(loadWalk()(undefined)).toBeNull()
    expect(loadWalk()(42)).toBeNull()
    const self: Record<string, unknown> = fiberNode({})
    self.return = self
    expect(() => loadWalk()(self)).not.toThrow()
    expect(loadWalk()(self)).toBeNull()
  })

  it('深度上限保护:超长链不会无限循环', () => {
    const nodes: Array<Record<string, unknown>> = []
    for (let i = 0; i < 1000; i++) nodes.push(fiberNode({ memoizedProps: {} }))
    const root = chain(...nodes)
    expect(loadWalk()(root)).toBeNull()
  })

  it('空数组也算命中(list 存在但是空目录)', () => {
    expect(loadWalk()(fiberNode({ memoizedProps: { list: [] } }))?.props.list).toEqual([])
  })
})

describe('夸克注入脚本:EXTRACT_JS', () => {
  it('语法有效', () => {
    expect(() => new Function(EXTRACT_JS)).not.toThrow()
  })

  it('内联了 walk 函数与候选选择器(不是引用,页面里没有模块系统)', () => {
    expect(EXTRACT_JS).toContain('function bowQuarkWalk')
    expect(EXTRACT_JS).toContain('file-list')
    expect(EXTRACT_JS).toContain('__reactFiber$')
    expect(EXTRACT_JS).toContain('__reactInternalInstance$')
    expect(EXTRACT_JS).toContain('selectedRowKeys')
  })

  it('失败一律带 diagnostics(页面改版时靠它定位)', () => {
    expect(EXTRACT_JS).toContain('diagnostics: diag')
    expect(EXTRACT_JS).toContain('stage')
    expect(EXTRACT_JS).toContain('propKeys')
  })

  it('绝不修改页面:没有写 DOM 的调用', () => {
    for (const forbidden of ['innerHTML', 'appendChild', 'document.write', 'removeChild', 'insertAdjacentHTML', 'outerHTML']) {
      expect(EXTRACT_JS, `EXTRACT_JS 不应包含 ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('是 IIFE 且返回一个值(executeJavaScript 取最后一个表达式)', () => {
    expect(EXTRACT_JS.startsWith('(function () {')).toBe(true)
    expect(EXTRACT_JS.trimEnd().endsWith('})()')).toBe(true)
  })
})
