<script setup lang="ts">
/**
 * 笔记设置分区(设置页 → 笔记):图目录 / 最近图 / 索引统计 / 从 `logseq/config.edn` 读到的配置。
 *
 * ⚠️ 这里**没有**「默认日志模板」的下拉框 —— 模板名是 Logseq 自己的 `config.edn` 里的
 * `:default-templates {:journals "…"}`,本插件只读不写;这里显示它读到了什么、有哪些模板文件可用。
 */
import { onMounted, ref } from 'vue'
import { FolderOpen, RefreshCw } from 'lucide-vue-next'
import type { GraphState } from '@plugins/logseq/shared'

const api = window.browserAPI

const state = ref<GraphState | null>(null)
const busy = ref(false)
const message = ref('')

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return api.plugins.invoke<T>('logseq', method, ...args)
}

async function refresh(): Promise<void> {
  busy.value = true
  try {
    state.value = await invoke<GraphState>('getState')
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function pick(): Promise<void> {
  await refresh()
  busy.value = true
  try {
    const res = await invoke<{ ok: boolean; error?: string; state: GraphState }>('pickGraph')
    state.value = res.state
    message.value = res.ok ? '' : (res.error ?? '选择失败')
  } finally {
    busy.value = false
  }
}

async function switchTo(path: string): Promise<void> {
  busy.value = true
  try {
    const res = await invoke<{ ok: boolean; error?: string; state: GraphState }>('setGraph', path)
    state.value = res.state
    message.value = res.ok ? '' : (res.error ?? '切换失败')
  } finally {
    busy.value = false
  }
}

async function rebuild(): Promise<void> {
  busy.value = true
  try {
    state.value = await invoke<GraphState>('rebuildIndex')
    message.value = '索引已重建'
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <section class="logseq-settings">
    <h3 class="section-title">图目录</h3>
    <p class="row">
      <code class="path">{{ state?.graphPath || '(还没选)' }}</code>
      <button class="ghost" :disabled="busy" @click="pick"><FolderOpen :size="13" /> 选择…</button>
      <button class="ghost" :disabled="busy" @click="rebuild"><RefreshCw :size="13" /> 重建索引</button>
    </p>
    <p v-if="state?.error" class="hint warn">{{ state.error }}</p>

    <template v-if="state && state.recentGraphs.length > 0">
      <h3 class="section-title">最近的图</h3>
      <ul class="recent">
        <li v-for="path in state.recentGraphs" :key="path">
          <code class="path">{{ path }}</code>
          <button class="ghost" :disabled="busy" @click="switchTo(path)">切换</button>
        </li>
      </ul>
    </template>

    <template v-if="state?.ok">
      <h3 class="section-title">索引</h3>
      <p class="kv">
        <span>文件 <b>{{ state.index?.files ?? 0 }}</b></span>
        <span>块 <b>{{ state.index?.blocks ?? 0 }}</b></span>
        <span>被引用的页面 <b>{{ state.index?.refs ?? 0 }}</b></span>
        <span>日志 <b>{{ state.index?.days ?? 0 }}</b></span>
      </p>
      <p v-if="state.index?.tooLarge" class="hint warn">
        图里的文件数超过索引上限,反链与搜索可能不全(仍能正常读写)。
      </p>

      <h3 class="section-title">从 logseq/config.edn 读到的配置</h3>
      <ul class="config">
        <li>日志目录:<code>{{ state.config.journalsDir }}/</code></li>
        <li>页面目录:<code>{{ state.config.pagesDir }}/</code></li>
        <li>
          日志文件名格式:<code>{{ state.dateFormat.format }}</code>
          <span v-if="state.dateFormat.ok === false" class="warn">
            —— 配置里用了不认识的 token(<code>{{ state.dateFormat.unsupported }}</code>),新建日志将按
            <code>{{ state.dateFormat.format }}</code> 写;已有的日期文件仍能被识别
          </span>
        </li>
        <li>
          默认日志模板:<code>{{ state.template.configured || '(没配)' }}</code>
          <span class="hint-inline">可用模板:{{ state.template.available.join('、') || '(templates/ 下没有 .md)' }}</span>
        </li>
        <li v-if="state.config.hidden.length > 0">索引时跳过:<code>{{ state.config.hidden.join(' ') }}</code></li>
      </ul>
      <p class="hint">
        这一节是**只读**的:模板与目录都写在 Logseq 自己的 <code>logseq/config.edn</code> 里,本插件从不写回它
        (在 Logseq 里改设置,这里刷新即可)。
      </p>
    </template>

    <p v-if="message" class="hint">{{ message }}</p>
  </section>
</template>

<style scoped>
.logseq-settings {
  font-size: 13px;
}

.section-title {
  margin: 18px 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
  text-transform: uppercase;
}

.section-title:first-child {
  margin-top: 0;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 0 0 8px;
}

.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ghost {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 3px 8px;
  font-size: 12px;
  color: var(--fg);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
}

.ghost:disabled {
  opacity: 0.5;
  cursor: default;
}

.recent,
.config {
  margin: 0;
  padding: 0;
  list-style: none;
}

.recent li,
.config li {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  padding: 3px 0;
}

.kv {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 0 0 8px;
  color: var(--fg-dim);
}

.kv b {
  color: var(--fg);
}

code {
  padding: 1px 5px;
  font-size: 12px;
  background: var(--bg3);
  border-radius: 3px;
}

.hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--fg-dim);
}

.hint.warn,
.warn {
  color: #e2b93d;
}

.hint-inline {
  font-size: 12px;
  color: var(--fg-dim);
}
</style>
