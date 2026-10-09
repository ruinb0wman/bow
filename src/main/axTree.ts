/**
 * 无障碍树(AX tree)→ 给 LLM 看的紧凑文本树。
 *
 * 为什么换掉 `SNAPSHOT_FN`:
 * 1. **句柄会静默打偏**。老快照的 `selFor()` 兜底生成 `div:nth-of-type(2)>ul:nth-of-type(1)>li:nth-of-type(7)>a:nth-of-type(1)`,
 *    页面一重排(分页、懒加载、插节点)这条选择器**仍然能 querySelector 到另一个元素** ——
 *    点击返回 ok 却打在错的东西上。这里的做法是 ref 显式失效并报错:宁可失败,不可静默打偏。
 * 2. **信息维度少**。老快照按写死的标签清单 `querySelectorAll`,拿不到 shadow DOM 内部、
 *    `div[onclick]`、`[tabindex]`、表格结构、`img alt`,也拿不到 `checked`/`disabled`/`level` 这些状态。
 * 3. **格式臃肿**。老快照每个元素 10 个字段、其中 `selector` 一条就 60+ 字符(实测 157 字符/元素),
 *    这里一行一个元素、约 30 字符/行 —— 同样的字节能装下多得多的信息。
 *
 * 这里只做**纯变换**(AX 节点数组 → 文本行 + ref 表),不碰 CDP,所以可以用伪造的节点数组真测。
 * 取树的部分在 `axSnapshot.ts`。
 *
 * 降噪规则有两条,都是**真机实测**出来的(不是拍脑袋):
 * - 文本去重:已在大化 name 里出现过的 StaticText 不再单出一行(实测大页上 913 条是这种重复);
 * - 标签镜像整棵丢掉:`LabelText`/`Legend` 与控件的 name 必然重复。
 */

/** 只取我们用得到的字段(CDP 返回的其它字段一律忽略) */
export interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: unknown }
  description?: { value?: string }
  properties?: Array<{ name: string; value?: { value?: unknown } }>
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
}

/** 渲染出的一个可寻址元素(ref 能指回真实节点) */
export interface AxRef {
  ref: string
  nodeId: string
  backendDOMNodeId: number
  frameId?: string
  role: string
  name: string
}

export interface AxRenderStats {
  /** AX 树里的全部节点数 */
  nodes: number
  /** 被浏览器标为 ignored 的(不可见 / aria-hidden / 无语义) */
  ignored: number
  /** 被当成「无信息容器」丢掉的角色数 */
  dropped: number
  /** 因为已被祖先的 accessible name 覆盖而没重复输出的文本数 */
  textDropped: number
}

export interface AxRenderResult {
  /** 文本树(每行一个元素,缩进表达层级) */
  text: string
  refs: AxRef[]
  truncated: boolean
  stats: AxRenderStats
}

/**
 * 角色分类。三档:
 * - `TRANSPARENT`:没有信息量的容器,自己不占一行但**要递归进孩子**(否则整棵子树会丢)
 * - `StaticText`:文本节点,单独走「是否已被祖先的 name 覆盖」那条规则
 * - 其它:照常渲染
 *
 * 加角色时的判据是「这行字对模型的下一步动作有没有用」,不是「有没有语义」。
 * 比如 `LabelText`(表单 `<label>` 的容器)和 `Legend` 总是与紧随其后的控件同名 → 丢;
 * 而 `list`/`row`/`cell` 这种虽然不能点,但决定了模型怎么读表格 → 留。
 */
const TRANSPARENT_ROLES = new Set(['none', 'generic', 'presentation', 'InlineTextBox', 'LineBreak', 'MenuListPopup'])

/**
 * 整棵子树都丢掉的角色。
 *
 * `LabelText`/`Legend` 是**标签的镜像**:它们存在的意义就是把文本交给控件的 accessible name,
 * 所以文本必然已经在控件的 name 里出现一次了(真机实测:`<label for=nick>昵称</label><input id=nick>`
 * 会输出 `- text: 昵称` 紧跟 `- textbox "昵称"`)。这里**不递归** —— 镜像里的链接极少,
 * 不值得为它把每个表单都写成两遍。
 */
const SKIP_SUBTREE_ROLES = new Set(['LabelText', 'Legend'])

/** 单个 name/text 的长度上限:一个超长文本节点不该把整棵树淹掉 */
const TEXT_LIMIT = 200

/** properties 里值得显示的状态(其余如 `focusable`/`clickable` 对模型没有决策价值) */
const STATE_KEYS = [
  'checked',
  'disabled',
  'expanded',
  'pressed',
  'selected',
  'required',
  'invalid',
  'readonly',
  'multiselectable',
  'modal'
] as const

const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim()

/**
 * 状态值可能是布尔 `true`,也可能是**字符串 `'true'`** —— Chromium 的属性值走 CDP 的
 * `AXValue`,三态属性(checked/expanded/pressed 这些)真机实测回的就是字符串 `'true'`。
 * 只认布尔会让树把勾选态整个吐掉(实测踩过)。
 */
function isOn(v: unknown): boolean {
  return v === true || v === 'true'
}

/** 读 AX 节点的某个 property 的 value */
function prop(node: AxNode, key: string): unknown {
  for (const p of node.properties ?? []) if (p.name === key) return p.value?.value
  return undefined
}

/** 这一行要显示的 `[状态]` 片段 */
function statesOf(node: AxNode, role: string): string {
  const out: string[] = []
  if (role === 'heading') {
    const level = prop(node, 'level')
    if (typeof level === 'number') out.push(`level=${level}`)
  }
  for (const key of STATE_KEYS) {
    const v = prop(node, key)
    if (isOn(v)) out.push(key)
    else if (v === 'mixed') out.push(`${key}=mixed`)
  }
  const value = clean(node.value?.value)
  if (value && value.length <= 40 && role !== 'StaticText') out.push(`value="${value}"`)
  return out.length ? ' [' + out.join(', ') + ']' : ''
}

export interface AxRenderOptions {
  /** 最多输出多少个**可寻址元素**(有 ref 的行),默认 200;<=0 表示不限 */
  maxElements?: number
  /** 从这棵子树开始渲染(配合 ref/selector 收窄);缺省从根开始 */
  rootNodeId?: string
}

/**
 * 把 AX 节点数组渲染成文本树。
 *
 * 两条降噪规则(都是实测出来的,不是拍脑袋):
 * - **文本去重**:`<button>提交</button>` 在 AX 树里是「button 节点(name=提交)」+「StaticText(提交)」两条,
 *   原样输出等于每行写两遍。实测大页上 913 条文本是这种重复。
 * - **容器透明**:`generic`/`none`/`LabelText` 这类容器自己不出行,但必须递归 —— 直接 return 会把子树整块丢掉。
 */
export function renderAxTree(nodes: AxNode[], opts: AxRenderOptions = {}): AxRenderResult {
  const maxElements = opts.maxElements && opts.maxElements > 0 ? opts.maxElements : 200
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const stats: AxRenderStats = { nodes: 0, ignored: 0, dropped: 0, textDropped: 0 }
  const refs: AxRef[] = []
  const lines: Array<{ depth: number; text: string }> = []
  let truncated = false

  // 根:父节点不在本树里的那些(含被过滤掉的父节点 —— 那种情况父节点其实在树里,所以不会误判)
  const roots = opts.rootNodeId
    ? [byId.get(opts.rootNodeId)].filter((n): n is AxNode => !!n)
    : nodes.filter((n) => !byId.has(n.parentId ?? ''))

  const emit = (depth: number, text: string): void => {
    lines.push({ depth, text })
  }

  const walk = (node: AxNode | undefined, depth: number, ancestorName: string): void => {
    if (!node || truncated) return
    stats.nodes++

    if (node.ignored) {
      stats.ignored++
      for (const cid of node.childIds ?? []) walk(byId.get(cid), depth, ancestorName)
      return
    }

    const role = clean(node.role?.value)
    const name = clean(node.name?.value).slice(0, TEXT_LIMIT)
    const childDepth = depth
    const descend = (dn: number, an: string): void => {
      for (const cid of node.childIds ?? []) walk(byId.get(cid), dn, an)
    }

    if (role === 'StaticText') {
      // 文本已经被祖先的 accessible name 覆盖(按钮/链接/标题都是这种) → 不再重复输出
      const covered = !!name && !!ancestorName && (ancestorName.includes(name) || name.includes(ancestorName))
      if (covered) {
        stats.textDropped++
        return
      }
      if (name) emit(depth, 'text: ' + name)
      return
    }

    if (role === 'RootWebArea') {
      // 文档根只是个容器,不占一行也不计入统计(否则每个 stat 都白 +1)
      descend(childDepth, ancestorName)
      return
    }

    if (SKIP_SUBTREE_ROLES.has(role)) {
      stats.dropped++
      return
    }

    if (TRANSPARENT_ROLES.has(role)) {
      stats.dropped++
      descend(childDepth, ancestorName)
      return
    }

    // 有 ref 的行才计入 maxElements —— 模型能操作的就是这些
    const addressable = node.backendDOMNodeId != null
    if (addressable && refs.length >= maxElements) {
      truncated = true
      return
    }

    let ref = ''
    if (addressable) {
      ref = 'e' + (refs.length + 1)
      refs.push({
        ref,
        nodeId: node.nodeId,
        backendDOMNodeId: node.backendDOMNodeId as number,
        role,
        name
      })
    }

    const label = role + (name ? ` "${name}"` : '')
    emit(depth, label + statesOf(node, role) + (ref ? ` [ref=${ref}]` : ''))
    descend(depth + 1, name || ancestorName)
  }

  for (const r of roots) walk(r, 0, '')
  if (truncated) {
    emit(0, `…(已达到 ${maxElements} 个元素的上限,页面还有更多。用 target 收窄到某个 ref 的子树,或调大 maxElements)`)
  }

  return {
    text: lines.map((l) => (l.depth ? '  '.repeat(l.depth) + '- ' + l.text : '- ' + l.text)).join('\n'),
    refs,
    truncated,
    stats
  }
}
