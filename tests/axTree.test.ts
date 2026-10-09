/**
 * a11y 树渲染器(`axTree.ts`)单测。
 *
 * 这层是纯变换(AX 节点数组 → 文本 + ref 表),不碰 CDP,所以直接喂伪造的节点数组 ——
 * 真机上拿AX 树的那部分由 `scripts/mcp-smoke.mjs` 与真机脚本覆盖。
 */

import { describe, expect, it } from 'vitest'
import { renderAxTree, type AxNode } from '../src/main/axTree'

interface Spec {
  role: string
  name?: string
  value?: string
  ignored?: boolean
  /** 明确不给 backendDOMNodeId(模拟不可寻址的节点) */
  noHandle?: boolean
  props?: Record<string, unknown>
  backendDOMNodeId?: number
  children?: Spec[]
}

let nextId = 0
let nextBackend = 0

/** 把嵌套描述摊成 CDP 风格的 AX 节点数组(带 nodeId/parentId/childIds) */
function tree(...specs: Spec[]): AxNode[] {
  nextId = 0
  nextBackend = 0
  const out: AxNode[] = []
  const walk = (s: Spec, parentId?: string): AxNode => {
    const nodeId = String(++nextId)
    const node: AxNode = { nodeId, role: { value: s.role } }
    if (s.name !== undefined) node.name = { value: s.name }
    if (s.value !== undefined) node.value = { value: s.value }
    if (s.ignored) node.ignored = true
    if (s.props) node.properties = Object.entries(s.props).map(([name, value]) => ({ name, value: { value } }))
    // 除 StaticText / ignored / 根之外都给一个句柄,减少测试里的样板
    if (s.backendDOMNodeId !== undefined) node.backendDOMNodeId = s.backendDOMNodeId
    else if (!s.noHandle && !s.ignored && s.role !== 'StaticText' && s.role !== 'RootWebArea') node.backendDOMNodeId = ++nextBackend
    if (parentId) node.parentId = parentId
    const kids = (s.children ?? []).map((c) => walk(c, nodeId))
    if (kids.length) node.childIds = kids.map((k) => k.nodeId)
    out.push(node)
    return node
  }
  specs.forEach((s) => walk(s))
  return out
}

const text = (s: string): Spec => ({ role: 'StaticText', name: s })

describe('renderAxTree:基本形状', () => {
  it('一行一个元素,层级靠缩进;状态与 ref 跟在后面', () => {
    const r = renderAxTree(
      tree({
        role: 'RootWebArea',
        name: '示例',
        children: [
          { role: 'heading', name: '标题', props: { level: 1 } },
          { role: 'checkbox', name: '我已阅读', props: { checked: true } },
          { role: 'button', name: '不可点', props: { disabled: true } },
          { role: 'textbox', name: '昵称', value: '张三' },
          { role: 'link', name: '首页' }
        ]
      })
    )
    expect(r.text.split('\n')).toEqual([
      '- heading "标题" [level=1] [ref=e1]',
      '- checkbox "我已阅读" [checked] [ref=e2]',
      '- button "不可点" [disabled] [ref=e3]',
      '- textbox "昵称" [value="张三"] [ref=e4]',
      '- link "首页" [ref=e5]'
    ])
    expect(r.refs.map((x) => x.ref)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
    expect(r.refs[0]).toMatchObject({ role: 'heading', name: '标题' })
    expect(typeof r.refs[0].backendDOMNodeId).toBe('number')
  })

  it('RootWebArea 自己不占行,但表头等结构角色保留(模型靠它读表格)', () => {
    const r = renderAxTree(
      tree({
        role: 'RootWebArea',
        children: [
          {
            role: 'table',
            name: '季度营收',
            children: [
              { role: 'row', children: [{ role: 'columnheader', name: '季度' }, { role: 'columnheader', name: '金额' }] },
              { role: 'row', children: [{ role: 'cell', name: 'Q1' }, { role: 'cell', name: '100' }] }
            ]
          }
        ]
      })
    )
    expect(r.text).toContain('- table "季度营收"')
    expect(r.text).toContain('  - row')
    expect(r.text).toContain('    - columnheader "季度"')
    expect(r.text).toContain('    - cell "Q1"')
  })

  it('mixed 这类非布尔状态也显示出来', () => {
    const r = renderAxTree(tree({ role: 'checkbox', name: '全选', props: { checked: 'mixed' } }))
    expect(r.text).toContain('[checked=mixed]')
  })

  it('状态值是真机那种字符串 "true" 时也要认出来(只认布尔会让勾选态整个吐掉)', () => {
    const r = renderAxTree(
      tree({ role: 'checkbox', name: '同意', props: { checked: 'true' }, children: [] })
    )
    expect(r.text).toContain('[checked]')
    const off = renderAxTree(tree({ role: 'checkbox', name: '不同意', props: { checked: 'false' } }))
    expect(off.text).not.toContain('[checked')
  })
})

describe('renderAxTree:降噪', () => {
  it('已被祖先 accessible name 覆盖的文本不再重复输出', () => {
    const r = renderAxTree(
      tree({
        role: 'RootWebArea',
        children: [{ role: 'button', name: '提交', children: [text('提交')] }]
      })
    )
    expect(r.text).toBe('- button "提交" [ref=e1]')
    expect(r.stats.textDropped).toBe(1)
  })

  it('没被覆盖的独立文本仍然要输出(它是页面内容,只是不可点)', () => {
    const r = renderAxTree(
      tree({
        role: 'RootWebArea',
        children: [
          {
            role: 'listitem',
            noHandle: true,
            children: [{ role: 'checkbox', name: '买牛奶' }, text('买牛奶是今天的事')]
          }
        ]
      })
    )
    expect(r.text).toContain('- text: 买牛奶是今天的事')
    // 文本行不该占 ref
    expect(r.text.split('\n').filter((l) => l.includes('ref='))).toHaveLength(1)
  })

  it('表单标签的文本不与控件的 name 重复:LabelText 是镜像,整棵丢掉', () => {
    const r = renderAxTree(
      tree({
        role: 'RootWebArea',
        children: [
          { role: 'LabelText', children: [text('昵称')] },
          { role: 'textbox', name: '昵称' }
        ]
      })
    )
    expect(r.text).toBe('- textbox "昵称" [ref=e1]')
  })

  it('无信息容器不出行,但孩子必须被提上来(直接 return 会把整棵子树丢掉)', () => {
    const r = renderAxTree(
      tree({
        role: 'RootWebArea',
        children: [{ role: 'generic', children: [{ role: 'LabelText', children: [text('昵称')] }, { role: 'textbox', name: '昵称' }] }]
      })
    )
    expect(r.text).toBe('- textbox "昵称" [ref=e1]')
    expect(r.stats.dropped).toBe(2)
  })

  it('ignored 的包装 div 也要穿透:它的孩子常常是有语义的', () => {
    const r = renderAxTree(
      tree({
        role: 'RootWebArea',
        children: [{ role: 'generic', ignored: true, children: [{ role: 'button', name: 'shadow 里的按钮' }] }]
      })
    )
    expect(r.text).toBe('- button "shadow 里的按钮" [ref=e1]')
    expect(r.stats.ignored).toBe(1)
  })

  it('超长文本被截断到 200 字符', () => {
    const r = renderAxTree(tree({ role: 'RootWebArea', children: [text('あ'.repeat(500))] }))
    expect(r.text.length).toBeLessThan(260)
  })
})

describe('renderAxTree:上限与收窄', () => {
  const many = (n: number): Spec => ({
    role: 'list',
    children: Array.from({ length: n }, (_, i) => ({ role: 'link', name: `第 ${i + 1} 项` }))
  })

  it('达到上限就截断,并告诉调用方下一步怎么办', () => {
    const r = renderAxTree(tree({ role: 'RootWebArea', children: [many(30)] }), { maxElements: 5 })
    expect(r.truncated).toBe(true)
    expect(r.refs).toHaveLength(5)
    expect(r.text).toContain('已达到 5 个元素的上限')
    expect(r.text).toContain('target')
    expect(r.text).not.toContain('第 6 项')
  })

  it('上限只数可寻址元素,文本行不占额度', () => {
    const r = renderAxTree(
      tree({
        role: 'RootWebArea',
        children: [
          { role: 'paragraph', noHandle: true, children: [text('一大段普通文字'), text('又一段普通文字')] },
          { role: 'button', name: '提交' }
        ]
      }),
      { maxElements: 1 }
    )
    expect(r.truncated).toBe(false)
    expect(r.text).toContain('text: 一大段普通文字')
    expect(r.text).toContain('- button "提交" [ref=e1]')
  })

  it('rootNodeId 只渲染那棵子树(用于 target 收窄)', () => {
    const nodes = tree({
      role: 'RootWebArea',
      children: [
        { role: 'navigation', name: '主导航', children: [{ role: 'link', name: '首页' }] },
        { role: 'main', children: [{ role: 'button', name: '正文按钮' }] }
      ]
    })
    const mainId = nodes.find((n) => n.role?.value === 'main')!.nodeId
    const r = renderAxTree(nodes, { rootNodeId: mainId })
    expect(r.text).toContain('- button "正文按钮"')
    expect(r.text).not.toContain('首页')
  })

  it('rootNodeId 指向不存在的节点时给空树,不抛错', () => {
    const r = renderAxTree(tree({ role: 'RootWebArea' }), { rootNodeId: 'nope' })
    expect(r.text).toBe('')
    expect(r.refs).toHaveLength(0)
  })
})

describe('renderAxTree:ref 与真实句柄的绑定', () => {
  it('每个 ref 都带着 backendDOMNodeId(后面靠它把 ref 解析回真实节点)', () => {
    const r = renderAxTree(
      tree({ role: 'RootWebArea', children: [{ role: 'button', name: 'A' }, { role: 'button', name: 'B' }] })
    )
    expect(r.refs.map((x) => x.backendDOMNodeId)).toEqual([1, 2])
  })

  it('ref 按渲染顺序递增且不重复', () => {
    const r = renderAxTree(
      tree({
        role: 'RootWebArea',
        children: [
          { role: 'heading', name: 'H' },
          { role: 'generic', children: [{ role: 'link', name: 'L1' }, { role: 'link', name: 'L2' }] },
          { role: 'button', name: 'B' }
        ]
      })
    )
    expect(r.refs.map((x) => x.ref)).toEqual(['e1', 'e2', 'e3', 'e4'])
  })

  it('没有 backendDOMNodeId 的节点不出 ref(不可寻址,不能假装能点)', () => {
    const r = renderAxTree(
      tree({ role: 'RootWebArea', children: [{ role: 'button', name: '固体', noHandle: true }] })
    )
    expect(r.text).toBe('- button "固体"')
    expect(r.refs).toHaveLength(0)
  })
})
