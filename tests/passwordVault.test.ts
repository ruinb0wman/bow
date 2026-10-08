/**
 * 密码库加解密用例(纯 node,不依赖 electron)。
 *
 * 重点:往返、错主密码、GCM 防篡改、改主密码、以及 scrypt 参数与 `maxmem` 的关系
 * —— 后者曾被「优化」掉就会直接抛错(scrypt 需要 32 MiB,正好顶到 Node 默认上限)。
 */

import { describe, expect, it } from 'vitest'
import {
  EMPTY_VAULT,
  IMPORT_KDF_LIMITS,
  SCRYPT_MAXMEM,
  SCRYPT_N,
  changeMaster,
  createVault,
  isInitialized,
  open,
  openEntries,
  parseVaultFile,
  reseal,
  seal,
  unlockVault
} from '../src/plugins/passwords/vault'
import type { PasswordEntry } from '../src/plugins/passwords/shared'

function entry(over: Partial<PasswordEntry> = {}): PasswordEntry {
  return {
    id: 'e1',
    title: '示例',
    origin: 'https://example.com',
    username: 'alice',
    password: 's3cret',
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

function flipByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64')
  buf[0] = buf[0] ^ 0xff
  return buf.toString('base64')
}

describe('密码库加解密', () => {
  it('未创建的密码库不算已初始化', () => {
    expect(isInitialized(EMPTY_VAULT)).toBe(false)
    expect(unlockVault(EMPTY_VAULT, '任意')).toBeNull()
  })

  it('创建 → 解锁 → 读回条目(含中文与特殊字符)', () => {
    const entries = [
      entry(),
      entry({ id: 'e2', origin: 'https://a.example.org', username: 'bob', password: 'p@ss"\\word' })
    ]
    const { file, key } = createVault('master-pass', entries)
    expect(isInitialized(file)).toBe(true)
    expect(file.kdf?.N).toBe(SCRYPT_N)
    expect(file.data?.ct).not.toContain('alice')

    const derived = unlockVault(file, 'master-pass')
    expect(derived).not.toBeNull()
    const back = openEntries(derived as Buffer, file)
    expect(back.map((e) => e.username)).toEqual(['alice', 'bob'])
    expect(back[1].password).toBe('p@ss"\\word')
    key.fill(0)
    ;(derived as Buffer).fill(0)
  })

  it('错误主密码返回 null', () => {
    const { file } = createVault('right', [entry()])
    expect(unlockVault(file, 'wrong')).toBeNull()
  })

  it('校验块被改 → 解锁失败(GCM tag 就是认证)', () => {
    const { file } = createVault('m', [entry()])
    const tampered = { ...file, verifier: { ...(file.verifier as object), ct: flipByte(file.verifier!.ct) } }
    expect(unlockVault(tampered, 'm')).toBeNull()
  })

  it('数据块被改 → 解锁成功但读条目抛错', () => {
    const { file } = createVault('m', [entry()])
    const tampered = { ...file, data: { ...(file.data as object), ct: flipByte(file.data!.ct) } }
    const derived = unlockVault(tampered, 'm')
    expect(derived).not.toBeNull()
    expect(() => openEntries(derived as Buffer, tampered)).toThrow()
  })

  it('reseal 换新 IV 且条目不变', () => {
    const { file, key } = createVault('m', [entry()])
    const resealed = reseal(file, key, [entry({ username: 'carol' })])
    expect(resealed.data?.iv).not.toBe(file.data?.iv)
    expect(openEntries(key, resealed)[0].username).toBe('carol')
    key.fill(0)
  })

  it('seal/open 往返', () => {
    const { key } = createVault('m')
    const sealed = seal(key, 'hello 世界')
    expect(open(key, sealed)).toBe('hello 世界')
    key.fill(0)
  })

  it('修改主密码后旧密码失效、新密码可用', () => {
    const created = createVault('old-pass', [entry()])
    created.key.fill(0)
    const { file, key } = changeMaster([entry({ username: 'dave' })], 'new-pass')
    expect(unlockVault(file, 'old-pass')).toBeNull()
    const derived = unlockVault(file, 'new-pass')
    expect(derived).not.toBeNull()
    expect(openEntries(derived as Buffer, file)[0].username).toBe('dave')
    key.fill(0)
    ;(derived as Buffer).fill(0)
  })

  it('scrypt 内存需求不超过显式 maxmem(128*N*r ≤ maxmem)', () => {
    expect(128 * SCRYPT_N * 8).toBeLessThanOrEqual(SCRYPT_MAXMEM)
  })
})

describe('parseVaultFile 导入校验', () => {
  const good = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(createVault('master-pass', []).file)) as Record<string, unknown>

  it('接受自己导出的备份(往返:导入后仍能用原主密码解锁)', () => {
    const file = parseVaultFile(good())
    expect(file).not.toBeNull()
    expect(isInitialized(file!)).toBe(true)
    const key = unlockVault(file!, 'master-pass')
    expect(key).not.toBeNull()
    ;(key as Buffer).fill(0)
  })

  it('拒绝:非对象 / 版本不对 / 三件套不全', () => {
    expect(parseVaultFile(null)).toBeNull()
    expect(parseVaultFile([])).toBeNull()
    expect(parseVaultFile('{}')).toBeNull()
    expect(parseVaultFile({ ...good(), version: 2 })).toBeNull()
    expect(parseVaultFile(EMPTY_VAULT)).toBeNull()
    expect(parseVaultFile({ ...good(), data: null })).toBeNull()
    expect(parseVaultFile({ ...good(), verifier: null })).toBeNull()
    expect(parseVaultFile({ ...good(), kdf: null })).toBeNull()
  })

  it('拒绝:Sealed 字段缺失或空串', () => {
    expect(parseVaultFile({ ...good(), data: { iv: 'a', tag: 'b' } })).toBeNull()
    expect(parseVaultFile({ ...good(), verifier: { iv: '', tag: 'b', ct: 'c' } })).toBeNull()
  })

  it('拒绝:算法不对 / 数字字段不合法 / keyLen 不符', () => {
    const base = good()
    const kdf = { ...(base.kdf as Record<string, unknown>) }
    expect(parseVaultFile({ ...base, kdf: { ...kdf, algo: 'pbkdf2' } })).toBeNull()
    expect(parseVaultFile({ ...base, kdf: { ...kdf, salt: '' } })).toBeNull()
    expect(parseVaultFile({ ...base, kdf: { ...kdf, N: 0 } })).toBeNull()
    expect(parseVaultFile({ ...base, kdf: { ...kdf, r: 1.5 } })).toBeNull()
    expect(parseVaultFile({ ...base, kdf: { ...kdf, p: -1 } })).toBeNull()
    expect(parseVaultFile({ ...base, kdf: { ...kdf, keyLen: 16 } })).toBeNull()
  })

  it('拒绝:会让 scrypt 吃爆内存的 KDF 参数(外部文件不该能调大算力)', () => {
    const base = good()
    const kdf = base.kdf as Record<string, unknown>
    expect(parseVaultFile({ ...base, kdf: { ...kdf, N: IMPORT_KDF_LIMITS.N * 2 } })).toBeNull()
    expect(parseVaultFile({ ...base, kdf: { ...kdf, r: IMPORT_KDF_LIMITS.r + 1 } })).toBeNull()
    expect(parseVaultFile({ ...base, kdf: { ...kdf, p: IMPORT_KDF_LIMITS.p + 1 } })).toBeNull()
    // 上界本身仍然接受(将来调参不会被误杀)
    expect(parseVaultFile({ ...base, kdf: { ...kdf, N: IMPORT_KDF_LIMITS.N } })).not.toBeNull()
  })
})
