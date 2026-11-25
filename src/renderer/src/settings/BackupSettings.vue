<script setup lang="ts">
/**
 * 设置页「备份」分区:统一导出 / 还原。
 *
 * 主进程负责一切(弹对话框、整包校验、原子写、还原后自动重启),这里只做两件事:
 * 置灰进行中的按钮、把结果(或具体错误)显示出来。
 * 还原成功后进程会自己重启 ⇒ 页面会直接消失,所以提示文案里要写清楚这一点。
 */
import { RButton } from '@ruinb0w/ui'
import { computed, onBeforeUnmount, ref } from 'vue'
import { ALL_DATA_FILES } from '@shared/backup'

const api = window.browserAPI

/** 改组件后别把 timeout 忘在 window 上:卸载时清掉,免得提示在别处冒出来 */
const busy = ref<'export' | 'restore' | null>(null)
const message = ref('')
const failed = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

const count = computed(() => ALL_DATA_FILES.length)

function show(text: string, bad = false): void {
  message.value = text
  failed.value = bad
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    message.value = ''
  }, 12000)
}

async function doExport(): Promise<void> {
  busy.value = 'export'
  try {
    const r = await api.backup.export()
    if (r.canceled) return
    if (r.error) show(`导出失败:${r.error}`, true)
    else show(`已保存到 ${r.path}`)
  } finally {
    busy.value = null
  }
}

async function doRestore(): Promise<void> {
  busy.value = 'restore'
  try {
    const r = await api.backup.restore()
    if (r.canceled) return
    if (r.error) show(`还原失败:${r.error}`, true)
    else show('已还原,bow 正在重启…')
  } finally {
    busy.value = null
  }
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <section class="bk">
    <div class="row">
      <RButton size="default" :loading="busy === 'export'" :disabled="busy !== null" @click="doExport">
        导出备份
      </RButton>
      <RButton size="default" :loading="busy === 'restore'" :disabled="busy !== null" @click="doRestore">
        从备份还原
      </RButton>
    </div>

    <p v-if="message" class="status" :class="{ bad: failed }">{{ message }}</p>

    <p class="hint">
      导出会把 <b>{{ count }} 份配置与数据</b>打成一个 <code>.json.gz</code> 包,保存位置由你在对话框里指定
      (默认是下载目录,文件名带日期)。还原会<b>先自动存一份当前状态</b>
      (<code>backup-before-restore.json.gz</code>,在 bow 的数据目录里),再覆盖,然后自动重启。
    </p>
    <p class="hint">
      包含:书签、浏览历史、下载记录与设置、密码库、终端与编辑器设置、番茄钟、本地服务、CORS 放行、
      设备检查、MCP HTTP 端口与令牌、核心设置与分屏布局、插件启停。
    </p>
    <p class="hint">
      <b>不含</b>:cookies 与登录态(换机器后网页要重新登录)、已下载的文件、日志。
      还原后若某些设置里写着旧机器的绝对路径(例如文件工作目录),需要自己改一下。
    </p>
    <p class="hint">
      单个插件自己的导出/导入(书签导出 JSON、密码库导入加密备份)仍然在各自的设置分区里,与这里不冲突。
    </p>
  </section>
</template>

<style scoped>
.bk {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 20px;
  max-width: 760px;
}

.row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.hint {
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.6;
}

.hint b {
  color: var(--fg);
}

.hint code {
  color: var(--fg);
}

.status {
  font-size: 12px;
  color: var(--fg-dim);
  word-break: break-all;
}

.status.bad {
  color: var(--danger, #e5534b);
}
</style>
