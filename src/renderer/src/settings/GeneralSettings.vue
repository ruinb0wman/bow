<script setup lang="ts">
/** 常规设置:默认搜索引擎 + 主页。改动即时保存(无保存/取消按钮)。 */
import { RFormRow, RRadio, RRadioGroup } from '@ruinb0w/ui'
import { onMounted, ref } from 'vue'
import type { Settings } from '@shared/types'
import { SEARCH_ENGINES } from '@shared/url'

const api = window.browserAPI
const DEFAULT_HOMEPAGE = 'https://www.google.com'

const searchEngine = ref<Settings['searchEngine']>('google')
const homepage = ref('')
let savedHomepage = ''
let savedEngine: Settings['searchEngine'] = 'google'

async function load(): Promise<void> {
  const s = await api.getSettings()
  searchEngine.value = s.searchEngine
  savedEngine = s.searchEngine
  homepage.value = s.homepage
  savedHomepage = s.homepage
}

/** RRadio 点一下会经 label 冒泡发两次 change —— 值没变就不重复写盘 */
async function saveSearchEngine(): Promise<void> {
  if (searchEngine.value === savedEngine) return
  const s = await api.setSettings({ searchEngine: searchEngine.value })
  savedEngine = s.searchEngine
  searchEngine.value = s.searchEngine
}

/** 主页:失焦/回车才写入;留空视为放弃修改,回填已存值 */
async function saveHomepage(e?: Event): Promise<void> {
  const el = e?.target as HTMLInputElement | undefined
  const next = (el?.value ?? homepage.value).trim()
  if (!next) {
    homepage.value = savedHomepage
    return
  }
  const s = await api.setSettings({ homepage: next })
  savedHomepage = s.homepage
  homepage.value = s.homepage
}

onMounted(() => void load())
</script>

<template>
  <RFormRow label="默认搜索引擎">
    <RRadioGroup v-model="searchEngine" @change="saveSearchEngine">
      <RRadio v-for="(v, key) in SEARCH_ENGINES" :key="key" :value="key" :label="v.label" />
    </RRadioGroup>
  </RFormRow>
  <RFormRow label="主页">
    <input
      v-model="homepage"
      class="pbm-input wide"
      spellcheck="false"
      :placeholder="DEFAULT_HOMEPAGE"
      @change="saveHomepage"
      @keydown.enter.prevent="saveHomepage"
    />
  </RFormRow>
  <div class="pbm-tools hint">
    主页在启动时打开新窗口的首页标签;地址栏输入内容按所选搜索引擎搜索。分屏布局改在工具栏的「分屏」面板里保存与套用。
  </div>
</template>
