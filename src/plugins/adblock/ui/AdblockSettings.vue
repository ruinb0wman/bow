<script setup lang="ts">
/**
 * 广告/追踪拦截设置分区:
 * - 网络规则 / 元素规则 / 文本规则 三个页签,均即时保存;
 * - 元素规则支持按域分组筛选;
 * - 文本页支持 AdGuard 语法编辑、导入导出与恢复内置默认。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { serializeRuleText } from '@shared/adblock'
import { Ban, Download, FileUp, Plus, RotateCcw, Trash2, Upload } from 'lucide-vue-next'

interface NetworkRule {
  id: string
  type: 'block' | 'allow'
  pattern: string
  enabled: boolean
  source: string
}

interface CosmeticRule {
  id: string
  type: 'hide' | 'unhide'
  domain: string
  selector: string
  enabled: boolean
  source: string
}

interface AdblockState {
  enabled: boolean
  blockedCount: number
  networkRules: NetworkRule[]
  cosmeticRules: CosmeticRule[]
  stats: { network: number; cosmetic: number; user: number }
}

interface ParseSummary {
  imported: number
  network: number
  cosmetic: number
  skipped: { count: number; samples: string[] }
}

const api = window.browserAPI
const state = ref<AdblockState>({
  enabled: true,
  blockedCount: 0,
  networkRules: [],
  cosmeticRules: [],
  stats: { network: 0, cosmetic: 0, user: 0 }
})
const tab = ref<'network' | 'cosmetic' | 'text'>('network')
const error = ref('')
const summary = ref<ParseSummary | null>(null)
const textDraft = ref('')
const unsubs: Array<() => void> = []
let msgTimer: ReturnType<typeof setTimeout> | null = null

// 新增网络规则
const newPattern = ref('')
const newType = ref<'block' | 'allow'>('block')
// 新增元素规则
const newSelector = ref('')
const newDomain = ref('*')
// 元素规则筛选
const filter = ref('')

async function refresh(): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'getState')
}

function flash(msg: string, isError = false): void {
  error.value = isError ? msg : ''
  if (!isError) return
  if (msgTimer) clearTimeout(msgTimer)
  msgTimer = setTimeout(() => {
    error.value = ''
  }, 4000)
}

function refreshText(): void {
  textDraft.value = serializeRuleText(state.value.networkRules, state.value.cosmeticRules, { includeBuiltin: false })
}

async function toggleEnabled(): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'setEnabled', state.value.enabled)
}

async function resetCount(): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'resetCount')
}

// ---------- 网络规则 ----------
async function addNetwork(): Promise<void> {
  const pattern = newPattern.value.trim()
  if (!pattern) {
    flash('规则模式不能为空', true)
    return
  }
  try {
    state.value = await api.plugins.invoke<AdblockState>('adblock', 'addNetworkRule', {
      pattern,
      type: newType.value
    })
    newPattern.value = ''
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e), true)
  }
}

async function updateNetwork(id: string, patch: Partial<NetworkRule>): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'updateNetworkRule', { id, ...patch })
}

async function removeNetwork(id: string): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'removeNetworkRule', { id })
}

// ---------- 元素规则 ----------
async function addCosmetic(): Promise<void> {
  const selector = newSelector.value.trim()
  if (!selector) {
    flash('CSS 选择器不能为空', true)
    return
  }
  try {
    state.value = await api.plugins.invoke<AdblockState>('adblock', 'addCosmeticRule', {
      selector,
      domain: newDomain.value.trim() || '*',
      type: 'hide'
    })
    newSelector.value = ''
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e), true)
  }
}

async function updateCosmetic(id: string, patch: Partial<CosmeticRule>): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'updateCosmeticRule', { id, ...patch })
}

async function removeCosmetic(id: string): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'removeCosmeticRule', { id })
}

const filteredCosmetic = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return state.value.cosmeticRules
  return state.value.cosmeticRules.filter(
    (r) => r.domain.toLowerCase().includes(q) || r.selector.toLowerCase().includes(q)
  )
})

const cosmeticGroups = computed(() => {
  const map = new Map<string, CosmeticRule[]>()
  for (const r of filteredCosmetic.value) {
    const arr = map.get(r.domain)
    if (arr) arr.push(r)
    else map.set(r.domain, [r])
  }
  return [...map.entries()]
})

// ---------- 文本规则 ----------
async function applyText(): Promise<void> {
  try {
    const res = await api.plugins.invoke<{ state: AdblockState; summary: ParseSummary }>(
      'adblock',
      'replaceUserRules',
      { text: textDraft.value }
    )
    state.value = res.state
    summary.value = res.summary
    flash('')
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e), true)
  }
}

async function resetDefaults(): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'resetDefaults')
  flash('')
}

async function copyExport(): Promise<void> {
  const res = await api.plugins.invoke<{ text: string }>('adblock', 'exportRules')
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(res.text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = res.text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    flash('')
  } catch {
    flash('复制失败,请使用「导出文件」', true)
  }
}

async function exportFile(): Promise<void> {
  const res = await api.plugins.invoke<{ text: string }>('adblock', 'exportRules')
  const blob = new Blob([res.text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'bow-adblock-rules.txt'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function onImportFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const text = await file.text()
  const res = await api.plugins.invoke<{ state: AdblockState; summary: ParseSummary }>('adblock', 'importRules', {
    text
  })
  state.value = res.state
  summary.value = res.summary
  refreshText()
}

async function pickElement(): Promise<void> {
  // 设置页是独立标签页:先切回最近浏览的页面标签,框选器才能在真实页面上工作
  const tab = await api.activateLastBrowsingTab()
  if (!tab) {
    flash('没有可用于框选的页面标签', true)
    return
  }
  void api.plugins.invoke('adblock', 'pickElement')
}

function switchTab(next: 'network' | 'cosmetic' | 'text'): void {
  tab.value = next
  if (next === 'text') refreshText()
}

onMounted(async () => {
  await refresh()
  refreshText()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id === 'adblock' && ev.event === 'changed') void refresh()
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  if (msgTimer) clearTimeout(msgTimer)
})
</script>

<template>
  <div class="set-row">
    <span class="set-label">广告拦截</span>
    <label class="set-check">
      <input v-model="state.enabled" type="checkbox" @change="toggleEnabled" />
      拦截网络规则命中的请求并隐藏元素规则命中的页面元素
    </label>
  </div>

  <div class="set-row">
    <span class="set-label">拦截统计</span>
    <span class="set-hcount">
      {{ state.blockedCount }} 次网络拦截 · {{ state.stats.network }} 条网络规则 ·
      {{ state.stats.cosmetic }} 条元素规则
    </span>
    <button class="btn" title="框选页面元素" @click="pickElement"><Ban :size="13" />屏蔽元素</button>
    <button class="btn" title="清零计数" @click="resetCount"><RotateCcw :size="13" />清零</button>
  </div>

  <div v-if="error" class="cors-error adb-error">{{ error }}</div>

  <div class="adb-tabs">
    <button class="adb-tab" :class="{ on: tab === 'network' }" @click="switchTab('network')">网络规则</button>
    <button class="adb-tab" :class="{ on: tab === 'cosmetic' }" @click="switchTab('cosmetic')">元素规则</button>
    <button class="adb-tab" :class="{ on: tab === 'text' }" @click="switchTab('text')">文本规则</button>
  </div>

  <!-- 网络规则 -->
  <div v-if="tab === 'network'" class="set-row set-col">
    <div class="adb-list">
      <div v-for="r in state.networkRules" :key="r.id" class="adb-rule">
        <label class="set-check adb-enable">
          <input
            type="checkbox"
            :checked="r.enabled"
            @change="updateNetwork(r.id, { enabled: ($event.target as HTMLInputElement).checked })"
          />
        </label>
        <select
          class="adb-select"
          :value="r.type"
          @change="updateNetwork(r.id, { type: ($event.target as HTMLSelectElement).value as 'block' | 'allow' })"
        >
          <option value="block">拦截</option>
          <option value="allow">放行</option>
        </select>
        <input
          v-model="r.pattern"
          class="pbm-input adb-pattern"
          spellcheck="false"
          @change="updateNetwork(r.id, { pattern: r.pattern })"
        />
        <span class="adb-badge">{{ r.source === 'builtin' ? '内置' : '用户' }}</span>
        <button class="btn danger" title="删除" @click="removeNetwork(r.id)"><Trash2 :size="13" /></button>
      </div>
      <div class="cors-add">
        <select v-model="newType" class="adb-select">
          <option value="block">拦截</option>
          <option value="allow">放行</option>
        </select>
        <input
          v-model="newPattern"
          class="pbm-input"
          spellcheck="false"
          placeholder="example.com / *.example.com / ||ads.example.com^ / */ads/*"
          @keydown.enter.prevent="addNetwork"
        />
        <button class="btn" title="添加" @click="addNetwork"><Plus :size="13" /></button>
      </div>
      <div class="pbm-tools hint">
        支持主机(含子域)、*.子域、||host^ 锚点与含 * 的 URL 通配;放行规则优先于拦截规则。主文档不会被拦截。
      </div>
    </div>
  </div>

  <!-- 元素规则 -->
  <div v-else-if="tab === 'cosmetic'" class="set-row set-col">
    <div class="adb-list">
      <div class="cors-add">
        <input v-model="newDomain" class="pbm-input adb-domain" spellcheck="false" placeholder="* 或 example.com" />
        <input
          v-model="newSelector"
          class="pbm-input"
          spellcheck="false"
          placeholder="CSS 选择器,如 .adsbygoogle"
          @keydown.enter.prevent="addCosmetic"
        />
        <button class="btn" title="添加" @click="addCosmetic"><Plus :size="13" /></button>
      </div>
      <input v-model="filter" class="pbm-input" spellcheck="false" placeholder="筛选域名或选择器…" />
      <div v-for="[domain, rules] in cosmeticGroups" :key="domain" class="adb-group">
        <div class="adb-group-head">{{ domain }}</div>
        <div v-for="r in rules" :key="r.id" class="adb-rule">
          <label class="set-check adb-enable">
            <input
              type="checkbox"
              :checked="r.enabled"
              @change="updateCosmetic(r.id, { enabled: ($event.target as HTMLInputElement).checked })"
            />
          </label>
          <span class="adb-kind" :class="{ allow: r.type === 'unhide' }">{{ r.type === 'unhide' ? '例外' : '隐藏' }}</span>
          <span class="adb-selector">{{ r.selector }}</span>
          <span class="adb-badge">{{ r.source === 'builtin' ? '内置' : r.source === 'picker' ? '框选' : '用户' }}</span>
          <button class="btn danger" title="删除" @click="removeCosmetic(r.id)"><Trash2 :size="13" /></button>
        </div>
      </div>
      <div v-if="cosmeticGroups.length === 0" class="pbm-tools hint">暂无匹配的元素规则</div>
      <div class="pbm-tools hint">
        域为该域及其子域生效,* 表示全站;选择器由「屏蔽元素」框选生成,也可手动编辑。
      </div>
    </div>
  </div>

  <!-- 文本规则 -->
  <div v-else class="set-row set-col">
    <div class="adb-list">
      <textarea v-model="textDraft" class="adb-text" spellcheck="false" rows="12"></textarea>
      <div class="adb-actions">
        <button class="btn primary" @click="applyText"><Upload :size="13" />应用</button>
        <button class="btn" @click="copyExport"><Download :size="13" />导出复制</button>
        <button class="btn" @click="exportFile"><Download :size="13" />导出文件</button>
        <label class="btn adb-file">
          <FileUp :size="13" />导入文件
          <input type="file" accept=".txt,text/plain" @change="onImportFile" />
        </label>
        <button class="btn" @click="resetDefaults"><RotateCcw :size="13" />恢复内置默认</button>
      </div>
      <div v-if="summary" class="pbm-tools hint">
        导入 {{ summary.imported }} 条(网络 {{ summary.network }} / 元素 {{ summary.cosmetic }}),跳过
        {{ summary.skipped.count }} 条<template v-if="summary.skipped.samples.length">
          :{{ summary.skipped.samples.join('、') }}</template
        >
      </div>
      <div class="pbm-tools hint">
        支持 AdGuard/EasyList 常用子集:||host^、host、*.host、* 通配、@@ 例外、domain##selector、domain#@#selector、!
        注释。此处仅编辑用户规则,应用后整体替换(内置规则不受影响)。
      </div>
    </div>
  </div>
</template>

<style scoped>
.adb-error {
  padding: 0 14px 8px;
}
.adb-tabs {
  display: flex;
  gap: 6px;
  padding: 4px 14px 0;
}
.adb-tab {
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg3);
  font-size: 12px;
}
.adb-tab.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
/* 规则列表占满设置页剩余高度(不再用 vh 上限) */
.set-row.set-col {
  flex: 1;
  min-height: 0;
}
.adb-list {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
}
.adb-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.adb-group-head {
  font-size: 12px;
  color: var(--fg-dim);
  padding-top: 4px;
  border-bottom: 1px solid var(--border);
}
.adb-rule {
  display: flex;
  align-items: center;
  gap: 8px;
}
.adb-enable {
  flex: none;
}
.adb-select {
  flex: none;
  width: 64px;
}
.adb-domain {
  flex: none;
  width: 150px;
}
.adb-pattern {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.adb-selector {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.adb-kind {
  flex: none;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
}
.adb-kind.allow {
  background: rgba(80, 180, 120, 0.25);
}
.adb-badge {
  flex: none;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--fg-dim);
}
.adb-text {
  width: 100%;
  box-sizing: border-box;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  resize: vertical;
  background: var(--bg3);
  color: inherit;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
}
.adb-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.adb-file {
  position: relative;
  overflow: hidden;
}
.adb-file input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
</style>
