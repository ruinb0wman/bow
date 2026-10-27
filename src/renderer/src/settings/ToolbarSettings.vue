<script setup lang="ts">
/**
 * 工具栏:插件按钮的上下顺序与隐藏(即时保存)。
 * 只列当前贡献了 toolbar 按钮的插件;停用的插件仍留在列表里,免得恢复启用后位置丢了。
 * 固定按钮(后退/前进/刷新/地址栏/分屏/设置)不参与排序。
 */
import { RButton } from '@ruinb0w/ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { PluginInfo } from '@shared/plugins'
import type { Settings } from '@shared/types'
import { mergeToolbarOrder, moveToolbarEntry } from '@shared/toolbarOrder'
import { ArrowDown, ArrowUp, Eye, EyeOff, RotateCcw } from '@lucide/vue'
import { PLUGIN_UI, SLOT_PLUGIN_ORDER } from '../plugins/registry'

const api = window.browserAPI
const unsubs: Array<() => void> = []

/** 可排序/可隐藏的插件(= 贡献了 toolbar 插槽的那些) */
const available = PLUGIN_UI.filter((ui) => (ui.slots?.toolbar?.length ?? 0) > 0).map((ui) => ui.id)

const plugins = ref<PluginInfo[]>([])
const order = ref<string[]>([])
const hidden = ref<Set<string>>(new Set<string>())

const rows = computed(() =>
  order.value.map((id) => {
    const info = plugins.value.find((p) => p.id === id)
    return { id, name: info?.name ?? id, enabled: !!info?.enabled, hidden: hidden.value.has(id) }
  })
)

/** `?? []` 兜的是「还没有这两个字段的旧 settings.json」 */
function apply(s: Settings): void {
  order.value = mergeToolbarOrder(s.toolbarOrder ?? [], SLOT_PLUGIN_ORDER.toolbar, available)
  hidden.value = new Set((s.toolbarHidden ?? []).filter((id) => available.includes(id)))
}

async function save(patch: Partial<Settings>): Promise<void> {
  apply(await api.setSettings(patch))
}

function move(id: string, delta: -1 | 1): void {
  void save({ toolbarOrder: moveToolbarEntry(order.value, id, delta) })
}

function toggleHidden(id: string): void {
  const next = new Set(hidden.value)
  if (!next.delete(id)) next.add(id)
  void save({ toolbarHidden: [...next] })
}

/** 恢复默认 = 清空两项设置(默认顺序仍由注册表给) */
function reset(): void {
  void save({ toolbarOrder: [], toolbarHidden: [] })
}

onMounted(async () => {
  apply(await api.getSettings())
  plugins.value = await api.plugins.list()
  unsubs.push(
    api.plugins.onChanged((list) => {
      plugins.value = list
    })
  )
})
onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <div class="set-row tt-top">
    <span class="set-label">工具栏顺序</span>
    <div class="tt-list">
      <div v-for="(r, i) in rows" :key="r.id" class="tt-row" :class="{ off: r.hidden }">
        <span class="tt-name">{{ r.name }}</span>
        <span v-if="!r.enabled" class="tt-tag">已停用</span>
        <span v-if="r.hidden" class="tt-tag">已隐藏</span>
        <span class="tt-gap" />
        <RButton size="small" title="上移" :disabled="i === 0" @click="move(r.id, -1)">
          <ArrowUp :size="13" />
        </RButton>
        <RButton size="small" title="下移" :disabled="i === rows.length - 1" @click="move(r.id, 1)">
          <ArrowDown :size="13" />
        </RButton>
        <RButton size="small" :title="r.hidden ? '在工具栏显示' : '在工具栏隐藏'" @click="toggleHidden(r.id)">
          <EyeOff v-if="r.hidden" :size="13" />
          <Eye v-else :size="13" />
        </RButton>
      </div>
    </div>
  </div>
  <div class="set-row">
    <span class="set-label">恢复</span>
    <RButton size="small" @click="reset"><RotateCcw :size="13" /> 恢复默认顺序与显示</RButton>
  </div>
  <div class="pbm-tools hint">
    只调整工具栏里的插件按钮。后退 / 前进 / 刷新、地址栏、分屏、设置这几个固定按钮不动;停用插件同样会收起它的按钮。
  </div>
</template>

<style scoped>
.tt-top {
  align-items: flex-start;
}
.tt-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.tt-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
}
.tt-row.off {
  opacity: 0.55;
}
.tt-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tt-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  white-space: nowrap;
}
.tt-gap {
  flex: 1;
}
</style>
