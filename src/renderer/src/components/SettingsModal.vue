<script setup lang="ts">
/** 设置弹层(运行在顶层 Overlay 页面中) */
import { onMounted, ref } from 'vue'
import type { Settings } from '@shared/types'
import { SEARCH_ENGINES } from '@shared/url'
import { X } from 'lucide-vue-next'

const api = window.browserAPI
const emit = defineEmits<{ close: [] }>()

const settingsDraft = ref<Settings>({ searchEngine: 'google', homepage: '' })

onMounted(async () => {
  settingsDraft.value = { ...(await api.getSettings()) }
})

async function saveSettings(): Promise<void> {
  const h = settingsDraft.value.homepage.trim()
  await api.setSettings({ searchEngine: settingsDraft.value.searchEngine, homepage: h || 'https://www.google.com' })
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
      <div class="set-actions">
        <button class="btn primary" @click="saveSettings">保存</button>
        <button class="btn" @click="emit('close')">取消</button>
      </div>
    </div>
  </div>
</template>