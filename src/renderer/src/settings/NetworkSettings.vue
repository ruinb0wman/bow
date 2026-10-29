<script setup lang="ts">
/**
 * 设置页「网络」分区:手动代理 / 直连 / 跟随系统 + 一个真连一次中立站点的测试。
 *
 * 背景:Electron 主进程里 Node 的 `fetch` 不读系统代理也不读 `HTTP(S)_PROXY`,Chromium 只认系统代理。
 * 这里配的代理会设到 Chromium 的 defaultSession 上,网页请求与 `net.fetch` 一起走它
 * (见 `main/proxy.ts` 顶部注释)。
 */
import { RBadge, RButton } from '@ruinb0w/ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Settings } from '@shared/types'
import type { ProxyDecision } from '@shared/proxy'
import { normalizeProxyServer } from '@shared/proxy'

const api = window.browserAPI

const settings = ref<Settings | null>(null)
const decision = ref<ProxyDecision | null>(null)
const hasEnv = ref('')
const resolved = ref('')
const draft = ref('')
const error = ref('')
const testing = ref(false)
const testResult = ref<{ ok: boolean; detail: string } | null>(null)
let unsub: (() => void) | null = null

/** 开关状态:manual 才算「用代理」;direct/system 与未设置都算关(关的时候仍可能是环境变量在起作用) */
const enabled = computed(() => settings.value?.proxyMode === 'manual')

const sourceText = computed(() => {
  const d = decision.value
  if (!d) return '…'
  if (d.kind === 'manual') return `来自${d.source === 'settings' ? '设置' : '环境变量'}:${d.server}`
  if (d.kind === 'direct') return '直连(不走任何代理)'
  return hasEnv.value
    ? '跟随系统(环境变量里的代理地址无法解析,已忽略)'
    : '跟随系统(Windows 上用系统代理设置;Linux 上通常等于直连)'
})

async function refresh(): Promise<void> {
  const info = await api.proxy.info()
  decision.value = info.decision
  hasEnv.value = info.env
  resolved.value = info.resolved
}

async function save(patch: Partial<Settings>): Promise<void> {
  settings.value = await api.setSettings(patch)
  draft.value = settings.value.proxyServer ?? ''
  await refresh()
}

/** 地址输入框失焦/回车:规范化后保存;非法就只报错,不动已存的值 */
async function commitServer(): Promise<void> {
  const raw = draft.value.trim()
  if (!raw) {
    error.value = ''
    await save({ proxyServer: '' })
    return
  }
  const server = normalizeProxyServer(raw)
  if (!server) {
    error.value = '地址要写成 http://127.0.0.1:7890(只支持 http/https/socks4/socks5,不支持账号密码)'
    return
  }
  error.value = ''
  draft.value = server
  await save({ proxyServer: server, proxyMode: settings.value?.proxyMode === 'manual' ? 'manual' : settings.value?.proxyMode })
}

async function toggle(): Promise<void> {
  if (enabled.value) {
    await save({ proxyMode: 'system' })
    return
  }
  const server = normalizeProxyServer(draft.value)
  if (!server) {
    error.value = '先填一个代理地址,再打开开关'
    return
  }
  error.value = ''
  draft.value = server
  await save({ proxyMode: 'manual', proxyServer: server })
}

async function test(): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await api.proxy.test()
  } finally {
    testing.value = false
  }
}

onMounted(async () => {
  settings.value = await api.getSettings()
  draft.value = settings.value.proxyServer ?? ''
  await refresh()
  unsub = api.onSettingsChanged((s) => {
    settings.value = s
  })
})
onBeforeUnmount(() => unsub?.())
</script>

<template>
  <section class="net">
    <div class="row">
      <label class="toggle">
        <input type="checkbox" :checked="enabled" @change="toggle" />
        <span>使用代理</span>
      </label>
      <input
        v-model="draft"
        class="input"
        spellcheck="false"
        placeholder="http://127.0.0.1:7890"
        @change="commitServer"
        @keydown.enter="commitServer"
      />
      <RButton size="default" :loading="testing" @click="test">
        <span>测试连接</span>
      </RButton>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="testResult" class="test" :class="{ bad: !testResult.ok }">
      {{ testResult.ok ? '连接 clients2.google.com 成功 · ' : '连接失败 · ' }}{{ testResult.detail }}
    </p>

    <p class="hint">
      当前生效:<b>{{ sourceText }}</b>
      <RBadge v-if="hasEnv && settings?.proxyMode !== 'manual'" type="info">环境变量</RBadge>
    </p>
    <p class="hint">Chromium 实际使用:<code>{{ resolved || '…' }}</code>(DIRECT = 直连)</p>

    <div class="modes">
      <RButton size="default" :active="settings?.proxyMode === 'direct'" @click="save({ proxyMode: 'direct' })">
        直连
      </RButton>
      <RButton size="default" :active="settings?.proxyMode === 'system' || !settings?.proxyMode" @click="save({ proxyMode: 'system' })">
        跟随系统
      </RButton>
    </div>

    <p class="hint">
      代理布到 Chromium 的会话上,<b>网页请求与 <code>net.fetch</code> 一起生效</b>。改完立即生效,无需重启。
      只支持 <code>http/https/socks</code> 地址,不支持账号密码、PAC 与 bypass 列表;
      启动时带 <code>--proxy-server</code> 则完全交给命令行。
    </p>
  </section>
</template>

<style scoped>
.net {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 20px;
  max-width: 760px;
}

.row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.toggle {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
  white-space: nowrap;
}

.input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev, var(--bg));
  color: var(--fg);
  font-size: 12px;
}

.modes {
  display: flex;
  gap: 8px;
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

.error {
  color: var(--danger, #e5534b);
  font-size: 12px;
}

.test {
  color: var(--fg-dim);
  font-size: 12px;
}

.test.bad {
  color: var(--danger, #e5534b);
}
</style>
