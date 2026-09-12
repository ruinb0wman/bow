<script setup lang="ts">
/** 设置弹层(运行在顶层 Overlay 页面中) */
import { onMounted, ref } from 'vue'
import type { Settings } from '@shared/types'
import { SEARCH_ENGINES } from '@shared/url'
import { normalizeCorsEntry } from '@shared/cors'
import { Eraser, Plus, Trash2, X } from 'lucide-vue-next'

const api = window.browserAPI
const emit = defineEmits<{ close: [] }>()

const settingsDraft = ref<Settings>({
  searchEngine: 'google',
  homepage: '',
  corsBypassEnabled: true,
  corsWhitelist: []
})
const newEntry = ref('')
const entryError = ref('')
const historyCount = ref(0)

onMounted(async () => {
  settingsDraft.value = { ...(await api.getSettings()) }
  historyCount.value = (await api.listHistory()).length
})

async function clearHistory(): Promise<void> {
  await api.clearHistory()
  historyCount.value = 0
}

function addEntry(): void {
  const norm = normalizeCorsEntry(newEntry.value)
  if (!norm) {
    entryError.value = '无效条目:应为域名、IP、host:端口 或 *.子域名'
    return
  }
  if (settingsDraft.value.corsWhitelist.includes(norm)) {
    entryError.value = `条目已存在:${norm}`
    return
  }
  settingsDraft.value.corsWhitelist = [...settingsDraft.value.corsWhitelist, norm]
  newEntry.value = ''
  entryError.value = ''
}

function removeEntry(i: number): void {
  settingsDraft.value.corsWhitelist = settingsDraft.value.corsWhitelist.filter((_, idx) => idx !== i)
}

async function saveSettings(): Promise<void> {
  const h = settingsDraft.value.homepage.trim()
  await api.setSettings({
    searchEngine: settingsDraft.value.searchEngine,
    homepage: h || 'https://www.google.com',
    corsBypassEnabled: settingsDraft.value.corsBypassEnabled,
    corsWhitelist: [...settingsDraft.value.corsWhitelist]
  })
  emit('close')
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal panel-settings">
      <div class="modal-head">
        <span>设置</span>
        <button class="win-btn" title="关闭" @click="emit('close')"><X :size="13" /></button>
      </div>
      <div class="set-row">
        <span class="set-label">默认搜索引擎</span>
        <div class="set-engines">
          <label v-for="(v, key) in SEARCH_ENGINES" :key="key" class="set-engine">
            <input v-model="settingsDraft.searchEngine" type="radio" :value="key" />
            {{ v.label }}
          </label>
        </div>
      </div>
      <div class="set-row">
        <span class="set-label">主页</span>
        <input v-model="settingsDraft.homepage" class="pbm-input wide" placeholder="https://www.google.com" />
      </div>
      <div class="set-row">
        <span class="set-label">浏览历史</span>
        <span class="set-hcount">{{ historyCount }} 条记录</span>
        <button class="btn danger" title="删除全部浏览历史记录" @click="clearHistory"><Eraser :size="13" />清除浏览历史</button>
      </div>
      <div class="set-row">
        <span class="set-label">CORS 放行</span>
        <label class="set-check">
          <input v-model="settingsDraft.corsBypassEnabled" type="checkbox" />
          放行白名单主机的跨域请求
        </label>
      </div>
      <div class="set-row set-col">
        <span class="set-label">白名单</span>
        <div class="cors-list">
          <div v-for="(entry, i) in settingsDraft.corsWhitelist" :key="entry + i" class="cors-row">
            <span class="cors-entry">{{ entry }}</span>
            <button class="btn danger" title="移除" @click="removeEntry(i)"><Trash2 :size="13" /></button>
          </div>
          <div class="cors-add">
            <input
              v-model="newEntry"
              class="pbm-input"
              placeholder="example.com / example.com:8080 / *.example.com / IP"
              @keydown.enter.prevent="addEntry"
            />
            <button class="btn" title="添加" @click="addEntry"><Plus :size="13" /></button>
          </div>
          <div v-if="entryError" class="cors-error">{{ entryError }}</div>
          <div class="pbm-tools hint">
            支持域名、IP、host:端口、*.子域名(不含主域)。名单内主机的响应自动带 CORS
            放行头;来源为名单内主机(如 localhost 开发页)的页面发起的跨域请求同样放行。
            开启时,发往 opencode.ai 的请求会自动附加稳定的会话头
          </div>
        </div>
      </div>
      <div class="set-actions">
        <button class="btn primary" @click="saveSettings">保存</button>
        <button class="btn" @click="emit('close')">取消</button>
      </div>
    </div>
  </div>
</template>