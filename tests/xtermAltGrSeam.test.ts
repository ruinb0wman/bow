/**
 * 契约测试:`ui/xtermCtrlAltChord.ts` 的 AltGr 误判补丁依赖 xterm 的两个内部名字
 * (`Terminal._core` 与 `CoreBrowserTerminal._isThirdLevelShift`)。
 *
 * `package.json` 里 `@xterm/xterm` 是 `^6.0.0`,升级时若改了它们,补丁会**静默**退化成
 * 「Ctrl+Alt+字母 继续丢键」(不会发出错字节,但也没人会发现)——
 * 这条用例把「静默」变成 CI 红。真红了怎么办:先看 `installWindowsCtrlAltChordRepair()`
 * 是否还能装上(E2E 的 `ctrlAltRepaired` 判据),再决定改判据还是改接缝,别直接删用例。
 *
 * 扫的是产物 `lib/xterm.mjs`(Vite 走 package.json 的 `module` 字段,渲染层用的就是它),
 * 不是 `src/`:6.0.0 的包里 `src/` 只是附带,产物才是真正跑的东西。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const bundle = readFileSync(new URL('../node_modules/@xterm/xterm/lib/xterm.mjs', import.meta.url), 'utf-8')

describe('xterm 内部接缝(AltGr 误判补丁依赖它)', () => {
  it('`_isThirdLevelShift` 仍是实例方法,且仍按实例属性调用(补丁靠覆盖实例属性生效)', () => {
    // 定义:压缩后形如 `_isThirdLevelShift(e,i){`
    expect(bundle).toMatch(/_isThirdLevelShift\([A-Za-z_$][\w$]*,\s*[A-Za-z_$][\w$]*\)\s*\{/)
    // 调用:必须是 `this._isThirdLevelShift(...)` 这种属性查找,而不是被内联/改名
    expect(bundle).toMatch(/\._isThirdLevelShift\(/)
  })

  it('公开 `Terminal` 仍把 core 放在 `_core` 上(补丁从 `term._core` 取它)', () => {
    expect(bundle).toMatch(/this\._core\s*=/)
  })
})
