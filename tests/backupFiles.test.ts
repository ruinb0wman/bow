/**
 * 备份清单(`@shared/backup` 的 `PLUGIN_DATA_FILES`)不许漂。
 *
 * 清单是静态的(不能靠内核 `storageCache`:被停用的插件不会 activate,它的文件就不在缓存里),
 * 所以必须有个东西钉住它 —— 手法与 `bundleScan.test.ts` 一致:直接扫源码文本。
 * 新插件加了 `ctx.storage({ file: 'x.json' })` 却忘了登记 → 这里红。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_FILES, PLUGIN_DATA_FILES } from '../src/shared/backup'

const PLUGINS_DIR = new URL('../src/plugins', import.meta.url).pathname

/** 扫描 `src/plugins/*\/main.ts` 里所有 `file: '…json'` 声明 */
function declaredPluginFiles(): string[] {
  const found = new Set<string>()
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let text: string
    try {
      text = readFileSync(join(PLUGINS_DIR, entry.name, 'main.ts'), 'utf-8')
    } catch {
      continue // 没有 main.ts 的目录(纯资源/纯 shared 插件)
    }
    for (const m of text.matchAll(/file:\s*'([\w.-]+\.json)'/g)) found.add(m[1])
  }
  return [...found].sort()
}

describe('备份清单覆盖插件数据文件', () => {
  it('源码里声明的每个数据文件都已登记', () => {
    const missing = declaredPluginFiles().filter((f) => !PLUGIN_DATA_FILES.includes(f))
    expect(missing).toEqual([])
  })

  it('清单里没有多余的(插件删了但还留着登记)', () => {
    const declared = declaredPluginFiles()
    const stale = PLUGIN_DATA_FILES.filter((f) => !declared.includes(f))
    expect(stale).toEqual([])
  })

  it('扫到的声明不是空集(否则说明扫描本身坏了)', () => {
    expect(declaredPluginFiles().length).toBeGreaterThanOrEqual(10)
  })

  it('核心文件与插件文件不重叠', () => {
    for (const f of CORE_FILES) expect(PLUGIN_DATA_FILES.includes(f)).toBe(false)
  })
})
