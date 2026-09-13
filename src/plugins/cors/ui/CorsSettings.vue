<script setup lang="ts">
/** CORS 放行插件设置分区(改动即时保存) */
import { onMounted, ref } from 'vue'
import { normalizeCorsEntry } from '@shared/cors'
import { Plus, Trash2 } from 'lucide-vue-next'

interface CorsSettings {
  enabled: boolean
  whitelist: string[]
}

const api = window.browserAPI
const draft = ref<CorsSettings>({ enabled: true, whitelist: [] })
const newEntry = ref('')
const entryError = ref('')

async function save(): Promise<void> {
  draft.value = await api.plugins.invoke<CorsSettings>('cors', 'setSettings', {
    enabled: draft.value.enabled,
    whitelist: [...draft.value.whitelist]
  })
}

function addEntry(): void {
  const norm = normalizeCorsEntry(newEntry.value)
  if (!norm) {
    entryError.value = '无效条目:应为域名、IP、host:端口 或 *.子域名'
    return
  }
  if (draft.value.whitelist.includes(norm)) {
    entryError.value = `条目已存在:${norm}`
    return
  }
  draft.value.whitelist = [...draft.value.whitelist, norm]
  newEntry.value = ''
  entryError.value = ''
  void save()
}

function removeEntry(i: number): void {
  draft.value.whitelist = draft.value.whitelist.filter((_, idx) => idx !== i)
  void save()
}

onMounted(async () => {
  draft.value = await api.plugins.invoke<CorsSettings>('cors', 'getSettings')
})
</script>

<template>
  <div class="set-row">
    <span class="set-label">CORS 放行</span>
    <label class="set-check">
      <input v-model="draft.enabled" type="checkbox" @change="save" />
      放行白名单主机的跨域请求
    </label>
  </div>
  <div class="set-row set-col">
    <span class="set-label">白名单</span>
    <div class="cors-list">
      <div v-for="(entry, i) in draft.whitelist" :key="entry + i" class="cors-row">
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
</template>
