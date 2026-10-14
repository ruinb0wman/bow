/**
 * 本地文件认领注册表:核心在**开本地文件之前**问一圈插件「这个文件你想怎么打开?」。
 *
 * 为什么需要它:启动参数(双击 / 右键 / 文件管理器「用 bow 打开」)最终都变成 `file://` 目标,
 * 而"用只读的浏览器标签打开"只是**默认**做法 —— 编辑器插件要把它换成"在 nvim 里打开"。
 * 核心不认识编辑器,只认识这条协议;决策全在插件里(与 `openDevToolsTab` / `uploadFiles`
 * 同一条分工:资源与权限在核心,判断在插件)。
 *
 * 三条纪律:
 * 1. **纯逻辑**,不 import electron / node:fs —— 调用方把路径算好传进来(可单测);
 * 2. `claim()` 是**同步**的:插件侧只需要「建标签 + 发事件」,不需要等 IO。真需要异步认领的
 *    插件应该改成先返回 true 再自己异步补,别把这条链改成 async(会牵动启动时序);
 * 3. **一个插件出问题不连累别人**:`match` / `open` 抛错只记日志,继续问下一个;全都没认领时
 *    返回 false,调用方照旧开标签 —— 最坏情况就是"回到今天的行为",不会出现"双击没反应"。
 */

export type LocalFileMode = 'open' | 'edit'

export interface LocalFileOpener {
  /** 插件 id(顺序与诊断用) */
  id: string
  /** 认不认这个文件。`mode` 为 `edit` 表示命令行带了 `--edit`(右键「用 bow 编辑」) */
  match(path: string, mode: LocalFileMode): boolean
  /** 认领了就由它负责打开;返回 false = 放弃(核心继续问下一个,最后照旧开标签) */
  open(path: string, mode: LocalFileMode): boolean
}

/** 插件注册时给的形状(id 由内核填) */
export type LocalFileOpenerSpec = Omit<LocalFileOpener, 'id'>

export class FileOpenerHost {
  private openers: LocalFileOpener[] = []

  constructor(private readonly onError: (openerId: string, phase: 'match' | 'open', error: unknown) => void = () => {}) {}

  /** 注册一个认领者(注册顺序 = 询问顺序);返回的 disposer 由内核在插件停用时调用 */
  add(pluginId: string, opener: LocalFileOpenerSpec): () => void {
    const reg: LocalFileOpener = {
      id: pluginId,
      match: (path, mode) => opener.match(path, mode),
      open: (path, mode) => opener.open(path, mode)
    }
    this.openers.push(reg)
    return () => {
      const i = this.openers.indexOf(reg)
      if (i >= 0) this.openers.splice(i, 1)
    }
  }

  /**
   * 问一圈:第一个认领成功的就是它。
   * 返回 true = 文件已经被人打开过了,调用方**不要**再开标签。
   */
  claim(path: string, mode: LocalFileMode): boolean {
    if (!path) return false
    for (const opener of [...this.openers]) {
      let matched = false
      try {
        matched = opener.match(path, mode)
      } catch (e) {
        this.onError(opener.id, 'match', e)
        continue
      }
      if (!matched) continue
      try {
        if (opener.open(path, mode)) return true
      } catch (e) {
        this.onError(opener.id, 'open', e)
      }
      // 认领了却打不开(返回 false / 抛错)→ 下一个继续接手,都不行就回落成开标签
    }
    return false
  }

  /** 当前注册者 id(按询问顺序),诊断与设置页展示用 */
  list(): string[] {
    return this.openers.map((o) => o.id)
  }
}
