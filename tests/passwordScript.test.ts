/**
 * 密码插件注入脚本用例:语法有效 + 数据内联安全 + 只送用户名不送密码。
 */

import { describe, expect, it } from 'vitest'
import {
  DETECT_JS,
  PICKER_GLOBAL,
  PICKER_TEARDOWN_JS,
  READ_FIELDS_JS,
  buildFillScript,
  buildPickerScript,
  type PickerCandidate
} from '../src/plugins/passwords/scripts'

describe('密码插件注入脚本', () => {
  it('四个脚本语法均有效', () => {
    expect(() => new Function(DETECT_JS)).not.toThrow()
    expect(() => new Function(READ_FIELDS_JS)).not.toThrow()
    expect(() => new Function(PICKER_TEARDOWN_JS)).not.toThrow()
    expect(() => new Function(buildFillScript({ username: 'a', password: 'b' }))).not.toThrow()
    expect(() => new Function(buildPickerScript([{ id: 'x', title: 't', username: 'u' }]))).not.toThrow()
  })

  it('探测脚本只回布尔,不读取字段值', () => {
    expect(DETECT_JS).toContain('hasPassword')
    expect(DETECT_JS).toContain('hasUsername')
    expect(DETECT_JS).not.toContain('pw.value')
    expect(DETECT_JS).not.toContain('un.value')
    expect(DETECT_JS).not.toContain('username:')
  })

  it('读字段脚本是唯一读取 .value 的脚本', () => {
    expect(READ_FIELDS_JS).toContain('.value')
    expect(READ_FIELDS_JS).toContain('password:')
  })

  it('填入脚本用原生 setter + input/change(受控输入框)', () => {
    const code = buildFillScript({ username: 'alice', password: 'p@ss' })
    expect(code).toContain('getOwnPropertyDescriptor')
    expect(code).toContain("new Event('input'")
    expect(code).toContain("new Event('change'")
    expect(code).toContain('values')
  })

  it('数据经 JSON.stringify 内联:引号 / 反斜杠 / 中文都不破坏语法', () => {
    const evilUser = 'a"b\\c\'d</script>中文'
    const code = buildFillScript({ username: evilUser, password: 'p " \\ \n' })
    expect(() => new Function(code)).not.toThrow()
    expect(code).toContain(JSON.stringify(evilUser))
  })

  it('下拉脚本只含用户名与标题,绝不含密码字段', () => {
    const candidates: PickerCandidate[] = [
      { id: 'e1', title: '示例', username: 'alice' },
      { id: 'e2', title: '工作', username: 'bob' }
    ]
    const code = buildPickerScript(candidates)
    expect(code).toContain(JSON.stringify(candidates))
    expect(code).toContain('attachShadow')
    expect(code).toContain('new Promise')
    expect(code).toContain('cancelled')
    expect(code).toContain('ArrowDown')
    expect(code).toContain('Escape')
    // 候选对象里没有 password 键,脚本里也不该出现任何密码载荷
    expect(code).not.toMatch(/password\s*[:=]\s*["']/)
  })

  it('候选里的 id 原样内联(选择结果要能对回条目)', () => {
    const code = buildPickerScript([{ id: 'id-"weird"', title: 't', username: 'u' }])
    expect(() => new Function(code)).not.toThrow()
    expect(code).toContain('id-\\"weird\\"')
  })

  it('拆除脚本认句柄常量', () => {
    expect(PICKER_TEARDOWN_JS).toContain(PICKER_GLOBAL)
    expect(PICKER_TEARDOWN_JS).toContain('.stop')
  })
})
