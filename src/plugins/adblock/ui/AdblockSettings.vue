<script setup lang="ts">
/**
 * 广告/追踪拦截设置分区:
 * - 网络规则 / 元素规则 / 订阅 / 文本规则 四个页签,均即时保存;
 * - 规则列表走后端分页(main 侧 listRules),避免几万条规则一次性灌进渲染层;
 * - 元素规则支持按域分组筛选,并展示文本导入带来的元素例外标记;
 * - 订阅页维护 EasyList/AdGuard 清单地址并手动更新。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Ban, Download, FileUp, Plus, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-vue-next'

interface NetworkRuleOptions {
  thirdParty?: boolean
  resourceTypes?: string[]
  excludeResourceTypes?: string[]
  domains?: { include: string[]; exclude: string[] }
  important?: boolean
}

interface NetworkRule {
  id: string
  type: 'block' | 'allow'
  pattern: string
  enabled: boolean
  source: string
  note?: string
  options?: NetworkRuleOptions
  subscriptionId?: string
}

interface CosmeticRule {
  id: string
  type: 'hide' | 'unhide'
  domain: string
  selector: string
  enabled: boolean
  source: string
  excludeDomains?: string[]
}

interface CosmeticFlagRule {
  id: string
  host: string
  generic?: boolean
  specific?: boolean
  enabled: boolean
  source: string
}

interface Subscription {
  id: string
  url: string
  title?: string
  enabled: boolean
  updatedAt: number
  error?: string
  ruleCount?: number
}

interface AdblockState {
  enabled: boolean
  blockedCount: number
  cosmeticFlags: CosmeticFlagRule[]
  subscriptions: Subscription[]
  stats: { network: number; cosmetic: number; user: number; flags: number; subscriptions: number }
}

interface ParseSummary {
  imported: number
  network: number
  cosmetic: number
  cosmeticFlags: number
  badfilters: number
  skipped: {
    count: number
    samples: string[]
    reasons: { options: number; scriptlet: number; foreign: number; other: number }
    foreignFormats: string[]
  }
}

interface RulePage<T> {
  items: T[]
  total: number
  matched: number
  offset: number
  limit: number
}

const PAGE_SIZE = 200

const api = window.browserAPI
const state = ref<AdblockState>({
  enabled: true,
  blockedCount: 0,
  cosmeticFlags: [],
  subscriptions: [],
  stats: { network: 0, cosmetic: 0, user: 0, flags: 0, subscriptions: 0 }
})
const tab = ref<'network' | 'cosmetic' | 'subs' | 'text'>('network')
const error = ref('')
const summary = ref<ParseSummary | null>(null)
const notice = ref('')
const textDraft = ref('')
const unsubs: Array<() => void> = []
let msgTimer: ReturnType<typeof setTimeout> | null = null
let filterTimer: ReturnType<typeof setTimeout> | null = null

// 网络规则(分页)
const netRules = ref<NetworkRule[]>([])
const netTotal = ref(0)
const netMatched = ref(0)
const netFilter = ref('')
// 元素规则(分页)
const cosRules = ref<CosmeticRule[]>([])
const cosTotal = ref(0)
const cosMatched = ref(0)
const cosFilter = ref('')

// 新增网络规则
const newPattern = ref('')
const newType = ref<'block' | 'allow'>('block')
// 新增元素规则
const newSelector = ref('')
const newDomain = ref('*')
// 订阅
const newSubUrl = ref('')
const newSubTitle = ref('')
const busy = ref(false)

async function refreshState(): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'getState')
}

function flash(msg: string, isError = false): void {
  error.value = isError ? msg : ''
  if (isError) {
    if (msgTimer) clearTimeout(msgTimer)
    msgTimer = setTimeout(() => {
      error.value = ''
    }, 4000)
    return
  }
  notice.value = msg
  if (msgTimer) clearTimeout(msgTimer)
  msgTimer = setTimeout(() => {
    notice.value = ''
  }, 4000)
}

function fail(e: unknown): void {
  flash(e instanceof Error ? e.message : String(e), true)
}

async function loadNetwork(reset = true): Promise<void> {
  const page = await api.plugins.invoke<RulePage<NetworkRule>>('adblock', 'listRules', {
    kind: 'network',
    keyword: netFilter.value,
    offset: reset ? 0 : netRules.value.length,
    limit: PAGE_SIZE
  })
  netRules.value = reset ? page.items : [...netRules.value, ...page.items]
  netTotal.value = page.total
  netMatched.value = page.matched
}

async function loadCosmetic(reset = true): Promise<void> {
  const page = await api.plugins.invoke<RulePage<CosmeticRule>>('adblock', 'listRules', {
    kind: 'cosmetic',
    keyword: cosFilter.value,
    offset: reset ? 0 : cosRules.value.length,
    limit: PAGE_SIZE
  })
  cosRules.value = reset ? page.items : [...cosRules.value, ...page.items]
  cosTotal.value = page.total
  cosMatched.value = page.matched
}

async function refresh(): Promise<void> {
  await refreshState()
  await Promise.all([loadNetwork(true), loadCosmetic(true)])
}

function refreshText(): void {
  void api.plugins
    .invoke<{ text: string }>('adblock', 'exportRules', { includeBuiltin: false })
    .then((res) => {
      textDraft.value = res.text
    })
    .catch(fail)
}

function onFilterInput(): void {
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    void loadNetwork(true).catch(fail)
    void loadCosmetic(true).catch(fail)
  }, 200)
}

async function toggleEnabled(): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'setEnabled', state.value.enabled)
}

async function resetCount(): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'resetCount')
}

/** 规则形状发生变化后:刷新统计 + 重载列表 */
async function afterMutation(next: AdblockState): Promise<void> {
  state.value = next
  await Promise.all([loadNetwork(true), loadCosmetic(true)])
}

// ---------- 网络规则 ----------
async function addNetwork(): Promise<void> {
  const pattern = newPattern.value.trim()
  if (!pattern) {
    flash('规则模式不能为空', true)
    return
  }
  try {
    const next = await api.plugins.invoke<AdblockState>('adblock', 'addNetworkRule', {
      pattern,
      type: newType.value
    })
    newPattern.value = ''
    await afterMutation(next)
  } catch (e) {
    fail(e)
  }
}

async function updateNetwork(id: string, patch: Partial<NetworkRule>): Promise<void> {
  try {
    const next = await api.plugins.invoke<AdblockState>('adblock', 'updateNetworkRule', { id, ...patch })
    state.value = next
  } catch (e) {
    fail(e)
    await loadNetwork(true)
  }
}

async function removeNetwork(id: string): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'removeNetworkRule', { id })
  await loadNetwork(true)
}

// ---------- 元素规则 ----------
async function addCosmetic(): Promise<void> {
  const selector = newSelector.value.trim()
  if (!selector) {
    flash('CSS 选择器不能为空', true)
    return
  }
  try {
    const next = await api.plugins.invoke<AdblockState>('adblock', 'addCosmeticRule', {
      selector,
      domain: newDomain.value.trim() || '*',
      type: 'hide'
    })
    newSelector.value = ''
    state.value = next
    await loadCosmetic(true)
  } catch (e) {
    fail(e)
  }
}

async function updateCosmetic(id: string, patch: Partial<CosmeticRule>): Promise<void> {
  try {
    state.value = await api.plugins.invoke<AdblockState>('adblock', 'updateCosmeticRule', { id, ...patch })
  } catch (e) {
    fail(e)
  }
}

async function removeCosmetic(id: string): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'removeCosmeticRule', { id })
  await loadCosmetic(true)
}

async function removeCosmeticFlag(id: string): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'removeCosmeticFlag', { id })
}

const cosmeticGroups = computed(() => {
  const map = new Map<string, CosmeticRule[]>()
  for (const r of cosRules.value) {
    const key = r.domain + (r.excludeDomains?.length ? ' (排除 ' + r.excludeDomains.join(',') + ')' : '')
    const arr = map.get(key)
    if (arr) arr.push(r)
    else map.set(key, [r])
  }
  return [...map.entries()]
})

function sourceLabel(r: { source: string }): string {
  if (r.source === 'builtin') return '内置'
  if (r.source === 'picker') return '框选'
  if (r.source === 'subscription') return '订阅'
  return '用户'
}

function optionsLabel(r: NetworkRule): string {
  const o = r.options
  if (!o) return ''
  const parts: string[] = []
  if (o.thirdParty === true) parts.push('第三方')
  else if (o.thirdParty === false) parts.push('第一方')
  if (o.resourceTypes?.length) parts.push(o.resourceTypes.join('/'))
  if (o.excludeResourceTypes?.length) parts.push('非' + o.excludeResourceTypes.join('/'))
  if (o.domains) parts.push('域:' + [...o.domains.include, ...o.domains.exclude.map((d) => '~' + d)].join('|'))
  if (o.important) parts.push('important')
  return parts.join(' ')
}

// ---------- 订阅 ----------
async function addSubscription(): Promise<void> {
  const url = newSubUrl.value.trim()
  if (!url) {
    flash('订阅地址不能为空', true)
    return
  }
  busy.value = true
  try {
    const res = await api.plugins.invoke<{ subscription: Subscription; updated: number; failed: number }>(
      'adblock',
      'addSubscription',
      { url, title: newSubTitle.value.trim() }
    )
    newSubUrl.value = ''
    newSubTitle.value = ''
    await refresh()
    if (res.subscription?.error) flash(`订阅拉取失败:${res.subscription.error}`, true)
    else flash(`订阅已更新:${res.subscription?.ruleCount ?? 0} 条规则`)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function refreshSubscriptions(id?: string): Promise<void> {
  busy.value = true
  try {
    const res = await api.plugins.invoke<{ updated: number; failed: number; errors: Array<{ error: string }> }>(
      'adblock',
      'refreshSubscriptions',
      id ? { id } : {}
    )
    await refresh()
    if (res.failed) flash(`${res.updated} 条订阅更新成功,${res.failed} 条失败:${res.errors[0]?.error ?? ''}`, true)
    else flash(`${res.updated} 条订阅已更新`)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function removeSubscription(id: string): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'removeSubscription', { id })
  await refresh()
}

async function toggleSubscription(sub: Subscription): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'setSubscriptionEnabled', {
    id: sub.id,
    enabled: sub.enabled
  })
  await refresh()
}

function formatTime(ts: number): string {
  if (!ts) return '未更新'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
    d.getHours()
  ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

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
    await Promise.all([loadNetwork(true), loadCosmetic(true)])
  } catch (e) {
    fail(e)
  }
}

async function resetDefaults(): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'resetDefaults')
  await Promise.all([loadNetwork(true), loadCosmetic(true)])
}

async function copyExport(): Promise<void> {
  const res = await api.plugins.invoke<{ text: string }>('adblock', 'exportRules', { includeBuiltin: true })
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
    flash('已复制全部规则')
  } catch {
    flash('复制失败,请使用「导出文件」', true)
  }
}

async function exportFile(): Promise<void> {
  const res = await api.plugins.invoke<{ text: string }>('adblock', 'exportRules', { includeBuiltin: true })
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
  await Promise.all([loadNetwork(true), loadCosmetic(true)])
  refreshText()
}

async function pickElement(): Promise<void> {
  // 设置页是独立标签页:先切回最近浏览的页面标签,框选器才能在真实页面上工作
  const tabInfo = await api.activateLastBrowsingTab()
  if (!tabInfo) {
    flash('没有可用于框选的页面标签', true)
    return
  }
  void api.plugins.invoke('adblock', 'pickElement')
}

function switchTab(next: 'network' | 'cosmetic' | 'subs' | 'text'): void {
  tab.value = next
  if (next === 'text') refreshText()
  if (next === 'network') void loadNetwork(true).catch(fail)
  if (next === 'cosmetic') void loadCosmetic(true).catch(fail)
}

onMounted(async () => {
  await refresh()
  refreshText()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id === 'adblock' && ev.event === 'changed') void refreshState()
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  if (msgTimer) clearTimeout(msgTimer)
  if (filterTimer) clearTimeout(filterTimer)
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
      {{ state.stats.cosmetic }} 条元素规则 · {{ state.stats.subscriptions }} 条订阅
    </span>
    <button class="btn" title="框选页面元素" @click="pickElement"><Ban :size="13" />屏蔽元素</button>
    <button class="btn" title="清零计数" @click="resetCount"><RotateCcw :size="13" />清零</button>
  </div>

  <div v-if="error" class="cors-error adb-error">{{ error }}</div>
  <div v-else-if="notice" class="pbm-tools hint adb-error">{{ notice }}</div>

  <div class="adb-tabs">
    <button class="adb-tab" :class="{ on: tab === 'network' }" @click="switchTab('network')">网络规则</button>
    <button class="adb-tab" :class="{ on: tab === 'cosmetic' }" @click="switchTab('cosmetic')">元素规则</button>
    <button class="adb-tab" :class="{ on: tab === 'subs' }" @click="switchTab('subs')">
      订阅<template v-if="state.stats.subscriptions"> ({{ state.stats.subscriptions }})</template>
    </button>
    <button class="adb-tab" :class="{ on: tab === 'text' }" @click="switchTab('text')">文本规则</button>
  </div>

  <!-- 网络规则 -->
  <div v-if="tab === 'network'" class="set-row set-col">
    <div class="adb-list">
      <input
        v-model="netFilter"
        class="pbm-input"
        spellcheck="false"
        placeholder="筛选模式 / 选项 / 备注…"
        @input="onFilterInput"
      />
      <div v-for="r in netRules" :key="r.id" class="adb-rule">
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
        <span v-if="optionsLabel(r)" class="adb-badge adb-opts">{{ optionsLabel(r) }}</span>
        <span v-if="r.note" class="adb-badge adb-warn">{{ r.note }}</span>
        <span class="adb-badge">{{ sourceLabel(r) }}</span>
        <button class="btn danger" title="删除" @click="removeNetwork(r.id)"><Trash2 :size="13" /></button>
      </div>
      <button v-if="netRules.length < netMatched" class="btn" @click="loadNetwork(false)">
        加载更多(已显示 {{ netRules.length }} / {{ netMatched }})
      </button>
      <div class="pbm-tools hint">
        共 {{ netTotal }} 条,当前显示 {{ netRules.length }} 条<template v-if="netFilter">
          (筛选命中 {{ netMatched }} 条)</template
        >。支持主机(含子域)、*.子域、||host^/||host/path 锚点与含 * 的 URL 通配;放行规则优先于拦截规则,
        $important 的拦截规则无视放行。主文档不会被拦截。
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
        这里不支持 $ 选项(避免被静默弱化);需要 third-party / domain= / important 等请用文本规则或订阅。
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
      <input v-model="cosFilter" class="pbm-input" spellcheck="false" placeholder="筛选域名或选择器…" @input="onFilterInput" />

      <div v-if="state.cosmeticFlags.length" class="adb-flags">
        <div v-for="f in state.cosmeticFlags" :key="f.id" class="adb-rule">
          <span class="adb-kind allow">例外</span>
          <span class="adb-selector">
            {{ f.host }} —— {{ f.generic && f.specific ? '关闭全部元素隐藏' : f.generic ? '只关泛化规则' : '只关专属规则' }}
          </span>
          <span class="adb-badge">文本导入</span>
          <button class="btn danger" title="删除" @click="removeCosmeticFlag(f.id)"><Trash2 :size="13" /></button>
        </div>
      </div>

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
          <span class="adb-badge">{{ sourceLabel(r) }}</span>
          <button class="btn danger" title="删除" @click="removeCosmetic(r.id)"><Trash2 :size="13" /></button>
        </div>
      </div>
      <button v-if="cosRules.length < cosMatched" class="btn" @click="loadCosmetic(false)">
        加载更多(已显示 {{ cosRules.length }} / {{ cosMatched }})
      </button>
      <div v-if="cosRules.length === 0" class="pbm-tools hint">暂无匹配的元素规则</div>
      <div class="pbm-tools hint">
        共 {{ cosTotal }} 条,当前显示 {{ cosRules.length }} 条。域为该域及其子域生效,* 表示全站;选择器由「屏蔽元素」框选生成,
        也可手动编辑。
      </div>
    </div>
  </div>

  <!-- 订阅 -->
  <div v-else-if="tab === 'subs'" class="set-row set-col">
    <div class="adb-list">
      <div v-for="sub in state.subscriptions" :key="sub.id" class="adb-rule adb-sub">
        <label class="set-check adb-enable">
          <input type="checkbox" :checked="sub.enabled" @change="toggleSubscription(sub)" />
        </label>
        <div class="adb-sub-main">
          <div class="adb-selector">
            {{ sub.title || sub.url }}
            <span v-if="sub.error" class="adb-badge adb-warn">失败</span>
            <span v-else class="adb-badge">{{ sub.ruleCount ?? 0 }} 条规则</span>
          </div>
          <div class="adb-sub-meta">
            {{ sub.url }} · {{ formatTime(sub.updatedAt) }}
            <template v-if="sub.error"> · {{ sub.error }}</template>
          </div>
        </div>
        <button class="btn" title="更新" :disabled="busy" @click="refreshSubscriptions(sub.id)">
          <RefreshCw :size="13" />
        </button>
        <button class="btn danger" title="删除" @click="removeSubscription(sub.id)"><Trash2 :size="13" /></button>
      </div>
      <div v-if="state.subscriptions.length === 0" class="pbm-tools hint">还没有订阅</div>

      <div class="cors-add">
        <input v-model="newSubTitle" class="pbm-input adb-domain" spellcheck="false" placeholder="备注名(可选)" />
        <input
          v-model="newSubUrl"
          class="pbm-input"
          spellcheck="false"
          placeholder="https://easylist-downloads.adblockplus.org/easylist.txt"
          @keydown.enter.prevent="addSubscription"
        />
        <button class="btn" :disabled="busy" title="添加并拉取" @click="addSubscription">
          <Plus :size="13" />
        </button>
      </div>
      <div class="adb-actions">
        <button class="btn primary" :disabled="busy" @click="refreshSubscriptions()">
          <RefreshCw :size="13" />更新全部
        </button>
      </div>
      <div class="pbm-tools hint">
        订阅按 EasyList/AdGuard 文本清单拉取;不支持的写法(scriptlet、过程式过滤、$removeparam 等)会被跳过并在订阅里体现为条数差异,
        绝不会降级成整域拦截。更新订阅会替换该订阅上一次导入的规则,不影响手动规则与内置规则。
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
        导入 {{ summary.imported }} 条(网络 {{ summary.network }} / 元素 {{ summary.cosmetic }} / 元素例外
        {{ summary.cosmeticFlags }}),跳过 {{ summary.skipped.count }} 条
        <template v-if="summary.skipped.count">
          —— 不支持选项 {{ summary.skipped.reasons.options }}、scriptlet/过程式
          {{ summary.skipped.reasons.scriptlet }}、其它格式 {{ summary.skipped.reasons.foreign
          }}<template v-if="summary.skipped.foreignFormats.length">
            (疑似 {{ summary.skipped.foreignFormats.join('/') }})</template
          >
        </template>
        <template v-if="summary.skipped.samples.length">。示例:{{ summary.skipped.samples.join('、') }}</template>
      </div>
      <div class="pbm-tools hint">
        支持 EasyList/AdGuard 子集:||host^、||host/path、host、*.host、* 通配、@@ 例外、$third-party / $~third-party、
        资源类型($script、$image、$xhr…)、$domain=a.com|~b.a.com、$important、$badfilter、domain##selector、domain#@#selector、
        ~domain 排除域、@@||host^$generichide|$elemhide|$specifichide、! 注释。不支持的写法(#?#、#$#、scriptlet、
        :has-text 等过程式过滤、$removeparam/$csp/$redirect 等)会整行跳过并汇总,不会降级成更宽的规则。
        此处仅编辑用户规则,应用后整体替换(内置规则与订阅不受影响)。
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
.adb-opts {
  font-family: ui-monospace, monospace;
}
.adb-warn {
  background: rgba(220, 140, 60, 0.25);
}
.adb-flags {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--border);
}
.adb-sub {
  align-items: flex-start;
}
.adb-sub-main {
  flex: 1;
  min-width: 0;
}
.adb-sub-meta {
  font-size: 11px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
