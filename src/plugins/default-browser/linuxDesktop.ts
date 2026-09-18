/**
 * Linux 桌面注册的纯逻辑:`.desktop` 文件内容、包装脚本内容、`mimeapps.list`
 * 的增 / 删 / 解析默认值 —— 全是字符串进字符串出,不碰文件系统。
 *
 * 真实的读写编排在 `registration.ts`,单测见 `tests/defaultBrowser.test.ts`。
 *
 * 为什么自己写文件而不是调 Electron 的 `app.setAsDefaultProtocolClient()`:
 * 它在 Linux 上依赖 xdg-utils(`xdg-settings`),精简系统 / 自建桌面上经常没装。
 */

/** 默认关联的类型:浏览器本体(http/https)+ 本地 html(双击 / 「用 bow 打开」) */
export const DEFAULT_MIME_TYPES = [
  'x-scheme-handler/http',
  'x-scheme-handler/https',
  'text/html',
  'application/xhtml+xml'
]

/** mimeapps.list 里写默认关联的段名 */
export const DEFAULT_SECTION = '[Default Applications]'

/** 生成标记:只覆盖带这个标记的文件 / 行,别人的同名文件绝不碰 */
export const MARKER = 'bow:browser'

export interface DesktopEntry {
  /** 要执行的命令(不含 `%U`,由本模块拼) */
  exec: string
  /** 桌面集成标识(与 app.setDesktopName() / package.json 的 build.appId 同源) */
  desktopName: string
  mimeTypes?: string[]
  appName?: string
  comment?: string
}

/** `.desktop` 内容(结尾带换行) */
export function desktopFileContent({
  exec,
  desktopName,
  mimeTypes = DEFAULT_MIME_TYPES,
  appName = 'bow',
  comment = 'AI 可操纵的简易浏览器(多标签 + MCP)'
}: DesktopEntry): string {
  return (
    [
      '[Desktop Entry]',
      `# ${MARKER} 由 bow 自己写入(设置 → 默认浏览器);删掉这行即可让脚本不再接管`,
      'Type=Application',
      `Name=${appName}`,
      `Comment=${comment}`,
      `Exec=${quoteExec(exec)} %U`,
      'Terminal=false',
      'Categories=Network;WebBrowser;',
      `MimeType=${mimeTypes.join(';')};`,
      'StartupNotify=true',
      // 与 app.setDesktopName() 一致:X11 下靠它把窗口与 .desktop 关联起来
      `StartupWMClass=${desktopName}`,
      ''
    ].join('\n')
  )
}

/**
 * `~/.local/bin/bow` 包装脚本内容(dev 模式没有稳定安装位置,只能包一层):
 *   `exec <electron 可执行文件> <仓库根目录> "$@"`
 *
 * 直推 electron 而不是 `node scripts/open-bow.mjs`:那样就不依赖系统里的 node,
 * 也不依赖仓库脚本存在(包装脚本只负责“普通启动 + 把参数递进去”,
 * 模式环境变量 / MCP 端点那些由 open-bow.mjs 负责的场合不需要包装脚本)。
 */
export function wrapperScriptContent({
  electronPath,
  appPath
}: {
  electronPath: string
  appPath: string
}): string {
  return (
    [
      '#!/bin/sh',
      `# ${MARKER}(由 bow 的设置页生成,勿手改;在「设置 → 默认浏览器」里撤销注册)`,
      `exec ${sh(electronPath)} ${sh(appPath)} "$@"`,
      ''
    ].join('\n')
  )
}

/** 该文件是不是我们生成的(靠标记判断,别人的同名文件不动) */
export function hasMarker(content: string): boolean {
  return content.includes(MARKER)
}

/** shell 双引号内的路径转义 */
export function sh(path: string): string {
  return `"${path.replace(/(["\\$`])/g, '\\$1')}"`
}

/** desktop 文件的 Exec 值:含空格等特殊字符时整体加双引号 */
export function quoteExec(path: string): string {
  return /[\s"'\\<>~|&;$*?#()`]/.test(path) ? sh(path) : path
}

/**
 * 解析 `mimeapps.list` 的 `[Default Applications]` 段 → `{ 类型: 值 }`。
 * 只读该段,其它段与注释一律忽略。
 */
export function parseDefaults(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let inSection = false
  for (const line of toLines(text)) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      inSection = line.trim() === DEFAULT_SECTION
      continue
    }
    if (!inSection) continue
    const kv = parseKv(line)
    if (kv) out[kv.key] = kv.value
  }
  return out
}

/**
 * 只动 `[Default Applications]` 段里指定的键:其它段落、其它键、注释、空行逐字保留。
 * 缺段则追加;缺键则插在段首(段头之后)。
 * 返回 `{ text, previous }`,`previous` 是被覆盖键的旧值(用于提示「原默认应用被覆盖」)。
 */
export function upsertDefaults(text: string, entries: Record<string, string>): { text: string; previous: Record<string, string> } {
  const lines = toLines(text)
  const headerIdx = lines.findIndex((l) => l.trim() === DEFAULT_SECTION)
  const previous: Record<string, string> = {}

  if (headerIdx < 0) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('')
    lines.push(DEFAULT_SECTION)
    for (const [key, value] of Object.entries(entries)) lines.push(`${key}=${value}`)
    return { text: lines.join('\n') + '\n', previous }
  }

  let endIdx = lines.length
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[.*\]\s*$/.test(lines[i])) {
      endIdx = i
      break
    }
  }

  const missing: string[] = []
  for (const [key, value] of Object.entries(entries)) {
    let found = false
    for (let i = headerIdx + 1; i < endIdx; i++) {
      const kv = parseKv(lines[i])
      if (!kv || kv.key !== key) continue
      previous[key] = kv.value
      lines[i] = `${key}=${value}`
      found = true
      break
    }
    if (!found) missing.push(`${key}=${value}`)
  }
  if (missing.length) lines.splice(headerIdx + 1, 0, ...missing)
  return { text: lines.join('\n') + '\n', previous }
}

/** 删除 `[Default Applications]` 段里值含 id 的键(撤销注册用);返回 `{ text, removed }` */
export function removeFromDefaults(text: string, id: string): { text: string; removed: string[] } {
  const out: string[] = []
  const removed: string[] = []
  let inSection = false
  for (const line of toLines(text)) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      inSection = line.trim() === DEFAULT_SECTION
      out.push(line)
      continue
    }
    if (inSection) {
      const kv = parseKv(line)
      if (kv && kv.value.split(';').map((s) => s.trim()).includes(id)) {
        removed.push(kv.key)
        continue
      }
    }
    out.push(line)
  }
  return { text: out.join('\n') + '\n', removed }
}

/** 段里某类型的值是不是我们(值可能是 `a.desktop;b.desktop;` 列表) */
export function valueTargetsUs(value: string | undefined, desktopId: string): boolean {
  if (!value) return false
  return value.split(';').map((s) => s.trim()).includes(desktopId)
}

/** `key=value` 行 → `{ key, value }`;不是键值行返回 null */
function parseKv(line: string): { key: string; value: string } | null {
  const m = /^\s*([^=\s][^=]*?)\s*=\s*(.*)$/.exec(line)
  return m ? { key: m[1].trim(), value: m[2].trim() } : null
}

/** 文本 → 行(统一 LF,并丢掉结尾那次换行产生的空串) */
function toLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}
