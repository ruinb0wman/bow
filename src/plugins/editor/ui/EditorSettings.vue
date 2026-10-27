<script setup lang="ts">
/**
 * 编辑器设置分区。
 *
 * 只配三件事 + 一个注册状态区:命令模板(可执行文件 + 参数)、路径写法、扩展名白名单。
 * 「有没有注册 / 系统当前把 .txt 交给谁」全部由主进程现算(这里连 `reg query` 都不碰),
 * 注册与撤销也只按键送过去 —— 判定与 I/O 只有一份实现(`../registration.ts`)。
 */
import { RButton } from '@ruinb0w/ui'
import { computed, onMounted, ref } from 'vue'
import { CheckCircle2, ExternalLink, FileCode2, Play, Save, XCircle } from '@lucide/vue'
import { WINDOWS_MANUAL_STEPS, type EditorSettings, type EditorStatus } from '../shared'

const api = window.browserAPI

const settings = ref<EditorSettings | null>(null)
const status = ref<EditorStatus | null>(null)
const log = ref<string[]>([])
const notice = ref('')
const busy = ref(false)
let noticeTimer: number | undefined

/** 参数与扩展名用「每行一项」编辑:参数里合法地含空格(如 `-lc 'nvim {file}'`),行编辑不用引号转义 */
const argsText = ref('')
const extsText = ref('')

const isWindows = computed(() => (status.value?.platform ?? '') === 'win32')
const extCount = computed(() => parseExts(extsText.value).length)

function flash(text: string, ms = 3600): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, ms)
}

function parseExts(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function fill(next: EditorSettings): void {
  settings.value = next
  argsText.value = next.args.join('\n')
  extsText.value = next.extensions.join(' ')
}

async function refresh(): Promise<void> {
  fill(await api.plugins.invoke<EditorSettings>('editor', 'getSettings'))
  status.value = await api.plugins.invoke<EditorStatus>('editor', 'status')
}

/** 改了控件就存(与其它插件一致:没有「保存」按钮那种状态机) */
async function patch(part: Partial<EditorSettings>): Promise<void> {
  fill(await api.plugins.invoke<EditorSettings>('editor', 'setSettings', part))
  status.value = await api.plugins.invoke<EditorStatus>('editor', 'status')
}

async function saveArgs(): Promise<void> {
  const args = argsText.value
    .split('\n')
    .map((a) => a.trim())
    .filter(Boolean)
  if (!args.some((a) => a.includes('{file}'))) flash('参数里没有 {file} 占位符:路径会被追加到末尾')
  await patch({ args })
}

async function saveExts(): Promise<void> {
  await patch({ extensions: parseExts(extsText.value) })
  flash(`已保存 ${extCount.value} 个扩展名`)
}

async function register(): Promise<void> {
  busy.value = true
  try {
    const result = await api.plugins.invoke<{ ok: boolean; log: string[]; status: EditorStatus }>(
      'editor',
      'register'
    )
    log.value = result.log
    status.value = result.status
    flash(result.ok ? '注册完成 —— 最后一步请在系统里点一次(见下方步骤)' : '注册未全部成功,看下面的日志', 6000)
  } finally {
    busy.value = false
  }
}

async function unregister(): Promise<void> {
  busy.value = true
  try {
    const result = await api.plugins.invoke<{ ok: boolean; log: string[]; status: EditorStatus }>(
      'editor',
      'unregister'
    )
    log.value = result.log
    status.value = result.status
    flash('已撤销注册')
  } finally {
    busy.value = false
  }
}

async function openSystemSettings(): Promise<void> {
  const res = await api.plugins.invoke<{ ok: boolean; message: string }>('editor', 'openSystemSettings')
  flash(res.message)
}

async function test(): Promise<void> {
  const res = await api.plugins.invoke<{ ok: boolean; error?: string }>('editor', 'test')
  if (!res.ok) flash(res.error ?? '起不来,看日志')
}

async function pickFile(): Promise<void> {
  const res = await api.plugins.invoke<{ ok: boolean; canceled?: boolean; error?: string }>('editor', 'pickFile')
  if (res.canceled) return
  if (!res.ok) flash(res.error ?? '没打开成功')
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <section class="editor-settings">
    <div class="section-title">编辑器命令</div>
    <div class="es-row">
      <label class="es-label">可执行文件</label>
      <input
        class="es-input"
        :value="settings?.shell ?? ''"
        placeholder="wsl.exe"
        @change="patch({ shell: ($event.target as HTMLInputElement).value })"
      />
    </div>
    <div class="es-row es-row-col">
      <label class="es-label">参数(每行一项,<code>{file}</code> 是文件路径占位符)</label>
      <textarea
        v-model="argsText"
        class="es-area"
        rows="3"
        spellcheck="false"
        placeholder="-e&#10;nvim&#10;{file}"
        @blur="saveArgs"
      />
    </div>
    <div class="es-row">
      <label class="es-label">路径写法</label>
      <select
        class="es-input"
        :value="settings?.pathStyle ?? 'native'"
        @change="patch({ pathStyle: ($event.target as HTMLSelectElement).value as 'wsl' | 'native' })"
      >
        <option value="wsl">wsl(C:\a\b.txt → /mnt/c/a/b.txt)</option>
        <option value="native">原样</option>
      </select>
    </div>
    <div class="es-hint">
      nvim 装在 WSL 里就保持默认(<code>wsl.exe</code> + <code>-e nvim {file}</code>);装在 Windows 上就改成
      <code>nvim.exe</code> + <code>{file}</code> + 「原样」。工作目录会设成<b>文件所在目录</b>,所以 nvim 里的
      <code>:e</code> / <code>gf</code> 找相对路径能用。
    </div>

    <div class="section-title">哪些文件交给编辑器</div>
    <div class="es-row es-row-col">
      <textarea v-model="extsText" class="es-area" rows="3" spellcheck="false" @blur="saveExts" />
      <div class="es-hint">
        共 {{ extCount }} 个(空格 / 逗号 / 换行分隔)。同一份清单干两件事:决定<b>双击哪个扩展名进编辑器</b>,
        以及<b>注册表里登记哪些候选</b>(不含 <code>.html/.htm</code> —— 那两个归默认浏览器插件)。
        右键「用 bow 编辑」不受清单限制的是<b>白名单内</b>的扩展名;清单外的文件用下面的「用编辑器打开…」。
      </div>
    </div>

    <div class="set-row es-actions">
      <RButton size="small" @click="test"><Play :size="13" />测试(开一个空编辑器)</RButton>
      <RButton size="small" @click="pickFile"><FileCode2 :size="13" />用编辑器打开…</RButton>
      <span v-if="notice" class="es-notice">{{ notice }}</span>
    </div>

    <template v-if="isWindows">
      <div class="section-title">Windows 上的注册</div>
      <div class="set-row es-actions">
        <RButton size="small" type="primary" :disabled="busy" @click="register"><Save :size="13" />注册</RButton>
        <RButton size="small" type="danger" plain :disabled="busy" @click="unregister">撤销注册</RButton>
        <RButton size="small" @click="openSystemSettings"><ExternalLink :size="13" />打开系统默认应用设置</RButton>
        <span v-if="status?.registered" class="es-state ok"><CheckCircle2 :size="13" />已注册</span>
        <span v-else class="es-state bad"><XCircle :size="13" />尚未注册</span>
      </div>
      <div v-if="status?.error" class="es-error">{{ status.error }}</div>
      <div v-if="status?.misses.length" class="es-hint">
        自校验没命中(可再点一次注册):{{ status.misses.slice(0, 6).join('、') }}
      </div>

      <div class="es-table">
        <div class="es-th">扩展名</div>
        <div class="es-th">系统当前交给谁</div>
        <div class="es-th">是不是 bow</div>
        <template v-for="t in status?.targets ?? []" :key="t.ext">
          <div class="es-td mono">{{ t.ext }}</div>
          <div class="es-td mono" :title="t.source ?? ''">{{ t.actualExe || t.effective || '—' }}</div>
          <div class="es-td">
            <span v-if="t.isDefault" class="es-state ok">是</span>
            <span v-else class="es-state bad" :title="t.fix">否</span>
          </div>
        </template>
      </div>

      <ol class="es-steps">
        <li v-for="(step, i) in WINDOWS_MANUAL_STEPS" :key="i">{{ step }}</li>
      </ol>
      <div v-for="(note, i) in status?.notes ?? []" :key="i" class="es-hint">{{ note }}</div>

      <pre v-if="log.length" class="es-log">{{ log.join('\n') }}</pre>
    </template>
  </section>
</template>

<style scoped>
/* 长列表在自己框内滚,不带动整页 */
.editor-settings {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 14px 20px;
  font-size: 13px;
}
.section-title {
  margin: 18px 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-dim);
}
.editor-settings .section-title:first-child {
  margin-top: 8px;
}
.es-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.es-row-col {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}
.es-label {
  flex: none;
  width: 200px;
  color: var(--fg-dim);
}
.es-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--fg);
  font-size: 12px;
}
.es-area {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: 6px 8px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--fg);
  font-family: ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.5;
}
.es-hint {
  margin: 2px 0 10px;
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.6;
}
.es-hint code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  font-family: ui-monospace, monospace;
}
.es-actions {
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.es-notice {
  color: var(--accent, #4a8ef7);
  font-size: 12px;
}
.es-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
}
.es-state.ok {
  background: rgba(80, 200, 120, 0.16);
  color: #7ec96a;
}
.es-state.bad {
  background: rgba(255, 170, 60, 0.16);
  color: #ffaa3c;
}
.es-error {
  margin: 6px 0;
  padding: 6px 10px;
  border-radius: var(--radius);
  background: rgba(229, 83, 75, 0.14);
  color: #ff9b93;
  font-size: 12px;
}
.es-table {
  display: grid;
  grid-template-columns: 90px 1fr 90px;
  gap: 2px 10px;
  margin: 8px 0;
  font-size: 12px;
}
.es-th {
  color: var(--fg-dim);
  font-size: 11px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.es-td {
  padding: 3px 0;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mono {
  font-family: ui-monospace, monospace;
}
.es-steps {
  margin: 6px 0;
  padding-left: 20px;
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.7;
}
.es-log {
  max-height: 220px;
  overflow: auto;
  margin: 8px 0 0;
  padding: 8px 10px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--fg-dim);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
}
</style>
