/**
 * 密码库的加解密(**只在主进程使用**,依赖 node:crypto)。
 *
 * 设计(见 `.pi/plans/2026-09-30-password-plugin/plan.md` §3):
 * - 主密码 → scrypt 派生 32 字节密钥(`N=2^15, r=8, p=1`);
 * - 校验块:用派生密钥把常量 `bow-passwords-v1` 密封起来 —— 解密失败即主密码不对(GCM 的 tag 就是认证);
 * - 数据块:把 `JSON.stringify({entries})` 整体密封,每次落盘换新 IV;
 * - 落盘的 `passwords.json` 里没有任何明文条目;盐与 KDF 参数不是机密,可以明文存。
 *
 * ⚠️ `maxmem` 必须显式给:scrypt 需要 `128 * N * r` 字节 = 32 MiB,正好等于 Node 的默认上限 32 MiB,
 * 不显式放宽会直接抛错(改小参数等于削弱强度,所以放宽上限而不是降 N)。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { normalizeEntries, type PasswordEntry } from './shared'

export const KDF_ALGO = 'scrypt'
export const SCRYPT_N = 1 << 15
export const SCRYPT_R = 8
export const SCRYPT_P = 1
export const KEY_LEN = 32
export const SCRYPT_MAXMEM = 64 * 1024 * 1024
export const VERIFIER_TEXT = 'bow-passwords-v1'
const IV_LEN = 12

export interface KdfParams {
  algo: typeof KDF_ALGO
  /** base64(盐不是机密) */
  salt: string
  N: number
  r: number
  p: number
  keyLen: number
}

export interface Sealed {
  iv: string
  tag: string
  ct: string
}

export interface VaultFile {
  version: 1
  kdf: KdfParams | null
  verifier: Sealed | null
  data: Sealed | null
}

export const EMPTY_VAULT: VaultFile = { version: 1, kdf: null, verifier: null, data: null }

/** 密码库是否已创建(三个字段齐备才算) */
export function isInitialized(file: VaultFile): boolean {
  return file.kdf != null && file.verifier != null && file.data != null
}

/** 新盐 + 默认 KDF 参数 */
export function newKdfParams(): KdfParams {
  return {
    algo: KDF_ALGO,
    salt: randomBytes(16).toString('base64'),
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keyLen: KEY_LEN
  }
}

/** 主密码 → 密钥(调用方负责在锁定/销毁时 `key.fill(0)`) */
export function deriveKey(master: string, kdf: KdfParams): Buffer {
  return scryptSync(master, Buffer.from(kdf.salt, 'base64'), kdf.keyLen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM
  })
}

/** AES-256-GCM 密封(每次调用都用新的随机 IV) */
export function seal(key: Buffer, plaintext: string): Sealed {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64')
  }
}

/** 解封;tag 不符(主密码错 / 文件被改)会抛错 */
export function open(key: Buffer, sealed: Sealed): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()])
  return pt.toString('utf8')
}

function sealVerifier(key: Buffer): Sealed {
  return seal(key, VERIFIER_TEXT)
}

/** 首次创建:新盐派生密钥 → 写校验块 + 空条目的数据块 */
export function createVault(master: string, entries: PasswordEntry[] = []): { file: VaultFile; key: Buffer } {
  const kdf = newKdfParams()
  const key = deriveKey(master, kdf)
  const file: VaultFile = {
    version: 1,
    kdf,
    verifier: sealVerifier(key),
    data: seal(key, JSON.stringify({ entries }))
  }
  return { file, key }
}

/** 用主密码解锁:成功返回密钥,失败(密码错或文件损坏)返回 null */
export function unlockVault(file: VaultFile, master: string): Buffer | null {
  if (!isInitialized(file)) return null
  const kdf = file.kdf as KdfParams
  const verifier = file.verifier as Sealed
  let key: Buffer
  try {
    key = deriveKey(master, kdf)
  } catch {
    return null
  }
  let actual: string
  try {
    actual = open(key, verifier)
  } catch {
    key.fill(0)
    return null
  }
  const expected = Buffer.from(VERIFIER_TEXT, 'utf8')
  const got = Buffer.from(actual, 'utf8')
  const ok = expected.length === got.length && timingSafeEqual(expected, got)
  expected.fill(0)
  got.fill(0)
  if (!ok) {
    key.fill(0)
    return null
  }
  return key
}

/** 解密条目表(必须在 `unlockVault` 成功之后调用;失败抛错) */
export function openEntries(key: Buffer, file: VaultFile): PasswordEntry[] {
  if (!file.data) return []
  const json = open(key, file.data)
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('密码库内容不是合法 JSON')
  }
  const entries = parsed && typeof parsed === 'object' ? (parsed as { entries?: unknown }).entries : undefined
  return normalizeEntries(entries)
}

/** 把条目表密封成新的数据块 */
export function sealEntries(key: Buffer, entries: PasswordEntry[]): Sealed {
  return seal(key, JSON.stringify({ entries }))
}

/** 用新数据块重写同密钥的密码库(返回新的 VaultFile,原对象不动) */
export function reseal(file: VaultFile, key: Buffer, entries: PasswordEntry[]): VaultFile {
  return { ...file, version: 1, data: sealEntries(key, entries) }
}

/** 修改主密码:换盐、换密钥、重封两个块 */
export function changeMaster(
  entries: PasswordEntry[],
  newMaster: string
): { file: VaultFile; key: Buffer } {
  return createVault(newMaster, entries)
}
