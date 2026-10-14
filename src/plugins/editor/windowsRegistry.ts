/**
 * 编辑器在 Windows 上的注册计划(纯逻辑,不碰注册表)。
 *
 * 与默认浏览器插件的差别在于「注册力度」:
 * - 默认浏览器要抢 http(s) 与 .html 的**默认处理程序**,所以写 `Classes\.html` 的默认值;
 * - 编辑器**只注册成候选** + 加一个「编辑」动词,不写 `Classes\.<ext>` 的默认值 ——
 *   双击 .txt 是否用 bow 打开,完全由用户在「设置 → 默认应用」里决定,注册不会偷改。
 *
 * 「编辑」动词的落点是 `Classes\SystemFileAssociations\.<ext>\shell\bow-edit\command`:
 * - **per-extension**、与该扩展名当前的处理程序无关(默认是记事本也能右键用 bow 编辑);
 * - 反面例子是把动词挂在 `Classes\.<ext>\shell` 下 —— 该扩展名一旦有 ProgID 就不生效(经典坑);
 * - 代价:Win11 的传统动词落在「显示更多选项」里(主菜单要 IExplorerCommand + MSIX 打包,不做)。
 *
 * 「设置 → 默认应用」里要能展开 bow,靠的是 `…\StartMenuInternet\bow\Capabilities\FileAssociations\`
 * ——**复用它**而不是新建 `RegisteredApplications\bow`(同一个名字写两遍会互相覆盖,
 * 而且设置页会出现两个 bow)。浏览器插件写 .html/.htm/.xhtml,这里写 .txt/.md/…,值名不重叠。
 */

import { win32 } from 'node:path'
import { DEFAULT_VALUE } from '../../main/plugins/registryOps'
import type { RegOp } from '../../main/plugins/registryOps'
import { EDIT_VERB, FRIENDLY_NAME, PROG_ID } from './shared'

/** 动词在右键菜单里的名字(中文;`MUIVerb` 就是菜单项文字) */
const VERB_LABEL = '用 bow 编辑'

export interface EditorRegistrationPlan {
  exe: string
  exeName: string
  progId: string
  /** `"<exe>" --edit "%1"` —— 「编辑」动词与 ProgID 的 open/edit 都指向它 */
  editCommand: string
  /** `"<exe>" "%1"` —— 只给「打开方式」的 open 动词用(白名单命中就进编辑器,否则浏览器标签) */
  openCommand: string
  icon: string
  extensions: string[]
  /** 「设置 → 默认应用」的展示位(与浏览器插件共用,本项目内置 bow 的名字固定为 `bow`) */
  capsKey: string
  adds: RegOp[]
  deletes: {
    values: Array<{ key: string; name: string }>
    keys: string[]
  }
  /** 「我们注册了没有」要查的键(全部命中才算 registered) */
  probes: RegOp[]
  /** 写入后自校验用的键(与 adds 同源,单独列出来是为了让调用方不必猜) */
  all: RegOp[]
}

export function buildEditorRegistration({
  exe,
  extensions,
  appName = 'bow'
}: {
  exe: string
  extensions: readonly string[]
  appName?: string
}): EditorRegistrationPlan {
  if (!exe || typeof exe !== 'string') throw new Error('buildEditorRegistration 需要 exe 路径')
  const exeName = win32.basename(exe)
  const icon = `${exe},0`
  const editCommand = `"${exe}" --edit "%1"`
  const openCommand = `"${exe}" "%1"`

  const classes = 'HKCU\\Software\\Classes'
  const progIdKey = `${classes}\\${PROG_ID}`
  const applicationKey = `${classes}\\Applications\\${exeName}`
  // ⚠️ 与默认浏览器插件共用这个键(值名不重叠:它写 .html/.htm/.xhtml,这里写文本/代码扩展名)
  const capsKey = `HKCU\\Software\\Clients\\StartMenuInternet\\${appName}\\Capabilities\\FileAssociations`
  const systemVerb = (ext: string) => `${classes}\\SystemFileAssociations\\${ext}\\shell\\${EDIT_VERB}`

  const adds: RegOp[] = [
    // 1) 文件类型 ProgID(图标 + open/edit 动词)
    { key: progIdKey, name: DEFAULT_VALUE, type: 'REG_SZ', data: FRIENDLY_NAME },
    { key: progIdKey, name: 'FriendlyTypeName', type: 'REG_SZ', data: FRIENDLY_NAME },
    { key: `${progIdKey}\\DefaultIcon`, name: DEFAULT_VALUE, type: 'REG_SZ', data: icon },
    { key: `${progIdKey}\\shell\\open\\command`, name: DEFAULT_VALUE, type: 'REG_SZ', data: editCommand },
    { key: `${progIdKey}\\shell\\edit`, name: DEFAULT_VALUE, type: 'REG_SZ', data: 'edit' },
    { key: `${progIdKey}\\shell\\edit`, name: 'MUIVerb', type: 'REG_SZ', data: VERB_LABEL },
    { key: `${progIdKey}\\shell\\edit`, name: 'Icon', type: 'REG_SZ', data: icon },
    { key: `${progIdKey}\\shell\\edit\\command`, name: DEFAULT_VALUE, type: 'REG_SZ', data: editCommand },

    // 2) 每个扩展名:候选 + 右键「用 bow 编辑」(与默认处理程序无关)
    ...extensions.flatMap((ext): RegOp[] => [
      { key: `${classes}\\${ext}\\OpenWithProgids`, name: PROG_ID, type: 'REG_NONE', data: '' },
      { key: systemVerb(ext), name: 'MUIVerb', type: 'REG_SZ', data: VERB_LABEL },
      { key: systemVerb(ext), name: 'Icon', type: 'REG_SZ', data: icon },
      { key: `${systemVerb(ext)}\\command`, name: DEFAULT_VALUE, type: 'REG_SZ', data: editCommand }
    ]),

    // 3) Applications 条目(「打开方式 → 更多应用」里的候选)
    { key: applicationKey, name: 'FriendlyAppName', type: 'REG_SZ', data: appName },
    { key: `${applicationKey}\\shell\\open\\command`, name: DEFAULT_VALUE, type: 'REG_SZ', data: openCommand },
    { key: `${applicationKey}\\shell\\edit\\command`, name: DEFAULT_VALUE, type: 'REG_SZ', data: editCommand },
    ...extensions.map(
      (ext): RegOp => ({ key: `${applicationKey}\\SupportedTypes`, name: ext, type: 'REG_NONE', data: '' })
    ),

    // 4) 「设置 → 默认应用」里的展示位(共用浏览器插件那个 Capabilities 键)
    ...extensions.map((ext): RegOp => ({ key: capsKey, name: ext, type: 'REG_SZ', data: PROG_ID }))
  ]

  // 撤销:只删自己写的**值**与自己建的**键**。
  // ⚠️ `SystemFileAssociations\.<ext>` 是公共位置(别人也可能往里写),只删 `shell\bow-edit` 这一个子键;
  //    绝不整段清 `SystemFileAssociations\.<ext>`,也不动 `RegisteredApplications\bow`(那是浏览器插件的)。
  const deletes = {
    values: [
      ...extensions.map((ext) => ({ key: `${classes}\\${ext}\\OpenWithProgids`, name: PROG_ID })),
      ...extensions.map((ext) => ({ key: capsKey, name: ext }))
    ],
    keys: [progIdKey, applicationKey, ...extensions.map((ext) => systemVerb(ext))]
  }

  // 状态探测:三处能共同回答「注册了没有」(ProgID 本体 / 候选登记 / 右键动词)
  const probes: RegOp[] = [
    { key: progIdKey, name: DEFAULT_VALUE },
    ...extensions.flatMap((ext): RegOp[] => [
      { key: `${classes}\\${ext}\\OpenWithProgids`, name: PROG_ID },
      { key: `${systemVerb(ext)}\\command`, name: DEFAULT_VALUE }
    ])
  ]

  return {
    exe,
    exeName,
    progId: PROG_ID,
    editCommand,
    openCommand,
    icon,
    extensions: [...extensions],
    capsKey,
    adds,
    deletes,
    probes,
    all: [...adds, ...probes]
  }
}

/** 一条写入 / 探测键 → 给人看的名字(日志与自校验列表用) */
export function regLabel(op: RegOp): string {
  if (op.key.includes('\\SystemFileAssociations\\')) {
    const ext = /\\SystemFileAssociations\\([^\\]+)\\/.exec(op.key)?.[1] ?? ''
    return `右键动词 ${ext}`
  }
  if (op.key.endsWith('\\OpenWithProgids')) {
    return `打开方式候选 ${win32.basename(op.key.replace(/\\OpenWithProgids$/, ''))}`
  }
  if (op.key.includes('\\Capabilities\\FileAssociations')) return `默认应用列表 ${op.name ?? '(默认)'}`
  if (op.key.includes('\\Applications\\')) return `应用条目 ${op.key.split('\\Applications\\')[1] ?? ''}`
  return op.key
}
