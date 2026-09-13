<script setup lang="ts">
/**
 * 历史插件设置分区(运行在核心设置弹层内):
 * - 配置保留条数(默认 500,立即裁剪);
 * - 模糊搜索历史,单条 / 批量删除,清空二次确认。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { HistoryList, HistorySettings } from '@shared/types'
import {
  HISTORY_CAP,
  HISTORY_CAP_MAX,
  HISTORY_CAP_MIN,
  formatHistoryTime,
  searchHistory
} from '@shared/history'
import { Save, Search, Trash2, X } from 'lucide-vue-next'

const api = window.browserAPI

/** 列表初次渲染条数;上限可达 10 万,分页渲染避免 DOM 过重 */
const PAGE_SIZE = 200

const list = ref<HistoryList>([])
const search = ref('')
const selected = ref<Set<string>>(new Set())
const renderLimit = ref(PAGE_SIZE)
const capInput = ref(String(HISTORY_CAP))
const capError = ref('')
const clearConfirm = ref(false)
const notice = ref('')
let noticeTimer: number | undefined
const unsubs: Array<() => void> = []

const filtered = computed(() => searchHistory(list.value, search.value))
const visible = computed(() => filtered.value.slice(0, renderLimit.value))
const remaining = computed(() => Math.max(0, filtered.value.length - renderLimit.value))
const hasSelection = computed(() => selected.value.size > 0)
const allSelected = computed(
  () => filtered.value.length > 0 && filtered.value.every((h) => selected.value.has(h.id))
)
const someSelected = computed(() => hasSelection.value && !allSelected.value)

function showNotice(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 2000)
}

function pruneSelection(): void {
  const alive = new Set(list.value.map((h) => h.id))
  const next = new Set<string>()
  for (const id of selected.value) if (alive.has(id)) next.add(id)
  selected.value = next
}

async function refresh(): Promise<void> {
  list.value = await api.plugins.invoke<HistoryList>('history', 'list')
  pruneSelection()
}

async function loadSettings(): Promise<void> {
  const s = await api.plugins.invoke<HistorySettings>('history', 'getSettings')
  capInput.value = String(s.maxEntries)
}

// ---------- 保留条数 ----------
async function saveCap(): Promise<void> {
  const n = Number(capInput.value)
  if (!Number.isInteger(n) || n < HISTORY_CAP_MIN || n > HISTORY_CAP_MAX) {
    capError.value = `请输入 ${HISTORY_CAP_MIN}–${HISTORY_CAP_MAX} 之间的整数`
    return
  }
  capError.value = ''
  const s = await api.plugins.invoke<HistorySettings>('history', 'setSettings', { maxEntries: n })
  capInput.value = String(s.maxEntries)
  showNotice(`已保留最近 ${s.maxEntries} 条`)
}

// ---------- 选择 ----------
function toggleOne(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function toggleAll(): void {
  if (allSelected.value) {
    selected.value = new Set()
    return
  }
  selected.value = new Set(filtered.value.map((h) => h.id))
}

// ---------- 删除 ----------
async function removeOne(id: string): Promise<void> {
  const removed = await api.plugins.invoke<number>('history', 'remove', [id])
  if (removed > 0) showNotice(`已删除 ${removed} 条`)
}

async function removeSelected(): Promise<void> {
  if (!hasSelection.value) return
  const removed = await api.plugins.invoke<number>('history', 'remove', [...selected.value])
  selected.value = new Set()
  showNotice(`已删除 ${removed} 条`)
}

async function clearAll(): Promise<void> {
  await api.plugins.invoke('history', 'clear')
  clearConfirm.value = false
  selected.value = new Set()
  showNotice('已清空浏览历史')
}

function loadMore(): void {
  renderLimit.value += PAGE_SIZE
}

// 搜索词变化:清空选中并重置分页
watch(search, () => {
  selected.value = new Set()
  renderLimit.value = PAGE_SIZE
})

onMounted(() => {
  void refresh()
  void loadSettings()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id !== 'history' || ev.event !== 'changed') return
      list.value = (ev.args as HistoryList) ?? []
      pruneSelection()
    })
  )
})
onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  if (noticeTimer) window.clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="hs">
    <!-- 保留条数 -->
    <div class="set-row hs-row">
      <span class="set-label">保留条数</span>
      <input
        v-model="capInput"
        class="pbm-input hs-cap"
        type="number"
        :min="HISTORY_CAP_MIN"
        :max="HISTORY_CAP_MAX"
        @keyup.enter="saveCap"
      />
      <span class="hs-unit">条</span>
      <button class="btn primary" title="保存并立即裁剪" @click="saveCap"><Save :size="13" />保存</button>
      <span class="set-hcount">共 {{ list.length }} 条记录</span>
    </div>
    <div v-if="capError" class="hs-error">{{ capError }}</div>

    <!-- 搜索 -->
    <div class="hs-search">
      <Search :size="14" class="hs-search-icon" />
      <input v-model="search" class="hs-search-input" placeholder="搜索历史(标题 / 网址 / 搜索词)…" spellcheck="false" />
      <button v-if="search" class="hs-clear" title="清空搜索" @click="search = ''"><X :size="13" /></button>
    </div>

    <!-- 操作条 -->
    <div class="hs-tools">
      <label class="set-check">
        <input type="checkbox" :checked="allSelected" :indeterminate="someSelected" @change="toggleAll" />
        全选({{ filtered.length }})
      </label>
      <button class="btn danger" :disabled="!hasSelection" @click="removeSelected">
        <Trash2 :size="13" />删除选中({{ selected.size }})
      </button>
      <template v-if="!clearConfirm">
        <button class="btn danger" :disabled="list.length === 0" @click="clearConfirm = true">清空历史</button>
      </template>
      <template v-else>
        <span class="hs-confirm">确认清空全部 {{ list.length }} 条?</span>
        <button class="btn danger" @click="clearAll">确认清空</button>
        <button class="btn" @click="clearConfirm = false">取消</button>
      </template>
      <span v-if="notice" class="hs-notice">{{ notice }}</span>
    </div>

    <!-- 列表 -->
    <div class="hs-list">
      <div v-if="filtered.length === 0" class="hs-empty">
        {{ search.trim() ? '无匹配结果' : '暂无历史记录' }}
      </div>
      <template v-else>
        <div
          v-for="h in visible"
          :key="h.id"
          class="hs-item"
          :class="{ picked: selected.has(h.id) }"
          @click="toggleOne(h.id)"
        >
          <input
            type="checkbox"
            :checked="selected.has(h.id)"
            @click.stop
            @change="toggleOne(h.id)"
          />
          <span class="hs-badge" :class="h.kind">{{ h.kind === 'search' ? '搜索' : '页面' }}</span>
          <div class="hs-main">
            <span class="hs-title">{{ h.query ?? h.title }}</span>
            <span class="hs-url">{{ h.url }}</span>
          </div>
          <span class="hs-time">{{ formatHistoryTime(h.visitedAt) }}</span>
          <button class="hs-del" title="删除此条" @click.stop="removeOne(h.id)"><X :size="12" /></button>
        </div>
        <div v-if="remaining > 0" class="hs-more">
          <button class="btn" @click="loadMore">加载更多(剩余 {{ remaining }})</button>
          <span class="hs-more-hint">已显示 {{ visible.length }} / {{ filtered.length }} 条</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.hs {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  min-width: 0;
}
.hs-row {
  flex-wrap: wrap;
}
.hs-cap {
  flex: none;
  width: 96px;
}
.hs-unit {
  flex: none;
  color: var(--fg-dim);
  font-size: 12px;
}
.hs-error {
  padding: 0 14px 8px 122px;
  color: var(--danger);
  font-size: 12px;
}
.hs-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 14px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg3);
}
.hs-search-icon {
  flex: none;
  color: var(--fg-dim);
}
.hs-search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: inherit;
  font-size: 13px;
}
.hs-clear {
  flex: none;
  display: inline-flex;
  color: var(--fg-dim);
}
.hs-clear:hover {
  color: inherit;
}
.hs-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 14px;
}
.hs-confirm {
  color: var(--danger);
  font-size: 12px;
}
.hs-notice {
  color: var(--fg-dim);
  font-size: 12px;
}
.hs-list {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  overflow-y: auto;
  border-top: 1px solid var(--border);
}
.hs-empty {
  padding: 18px 14px;
  color: var(--fg-dim);
  font-size: 12px;
  text-align: center;
}
.hs-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  cursor: pointer;
}
.hs-item:hover {
  background: var(--bg3);
}
.hs-item.picked {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.hs-badge {
  flex: none;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  white-space: nowrap;
}
.hs-badge.search {
  background: rgba(80, 160, 255, 0.22);
}
.hs-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.hs-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.hs-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-dim);
  font-size: 11px;
}
.hs-time {
  flex: none;
  color: var(--fg-dim);
  font-size: 11px;
  white-space: nowrap;
}
.hs-del {
  flex: none;
  display: inline-flex;
  color: var(--fg-dim);
}
.hs-del:hover {
  color: var(--danger);
}
.hs-more {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
}
.hs-more-hint {
  color: var(--fg-dim);
  font-size: 12px;
}
</style>
