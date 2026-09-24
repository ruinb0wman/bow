<script setup lang="ts">
/**
 * 夸克网盘设置分区:伪装 UA / Cookie 域名白名单 / aria2 RPC。
 * UA 做成可编辑字段是刻意的:整套方案靠「伪装官方 PC 客户端 UA」,
 * 夸克一升级客户端就要改这个字符串 —— 让用户自己改,不用等插件发版。
 */
import { onMounted, ref } from 'vue'
import { RotateCcw, Wifi } from 'lucide-vue-next'
import {
  DEFAULT_QUARK_SETTINGS,
  QUARK_UA_DEFAULT,
  normalizeHostList,
  type QuarkSettings
} from '../shared'

const api = window.browserAPI
const state = ref<QuarkSettings | null>(null)
const uaInput = ref('')
const hostsInput = ref('')
const notice = ref('')
const testing = ref(false)
let noticeTimer: number | undefined

function flash(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 2600)
}

function apply(next: QuarkSettings): void {
  state.value = next
  uaInput.value = next.userAgent
  hostsInput.value = next.cookieHosts.join(', ')
}

async function refresh(): Promise<void> {
  apply(await api.plugins.invoke<QuarkSettings>('quark', 'getSettings'))
}

async function save(patch: Partial<QuarkSettings>): Promise<void> {
  apply(await api.plugins.invoke<QuarkSettings>('quark', 'setSettings', patch))
}

async function saveUa(): Promise<void> {
  await save({ userAgent: uaInput.value })
  flash('已保存伪装 UA')
}

async function resetUa(): Promise<void> {
  await save({ userAgent: QUARK_UA_DEFAULT })
  flash('已恢复默认 UA')
}

async function saveHosts(): Promise<void> {
  const hosts = normalizeHostList(hostsInput.value, [])
  if (hosts.length === 0) {
    // 空白名单 = 永不注入 Cookie。允许,但要说清楚后果。
    flash('白名单为空:不会向直链域名注入 Cookie')
  }
  await save({ cookieHosts: hosts.length > 0 ? hosts : [] })
  if (hosts.length > 0) flash('已保存 Cookie 域名白名单')
}

async function saveAria2(field: keyof QuarkSettings['aria2'], value: string): Promise<void> {
  const cur = state.value ?? DEFAULT_QUARK_SETTINGS
  await save({ aria2: { ...cur.aria2, [field]: value } })
}

async function testAria2(): Promise<void> {
  testing.value = true
  try {
    const res = await api.plugins.invoke<{ ok: boolean; version?: string; error?: string }>('quark', 'testAria2')
    flash(res.ok ? `aria2 连接正常(版本 ${res.version})` : `连接失败:${res.error ?? '未知错误'}`)
  } finally {
    testing.value = false
  }
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <section class="quark-settings">
    <div class="section-title">伪装客户端</div>
    <div class="set-row qk-col">
      <span class="set-label">User-Agent</span>
      <input v-model="uaInput" class="qk-input" spellcheck="false" @blur="saveUa" />
      <div class="qk-hint">
        夸克的取直链接口与 CDN 都按这个 UA 判定「是不是官方 PC 客户端」,是整套方案的命门。
        夸克升级客户端导致取不到直链时,把新版客户端的 UA 贴进来即可。
        <button class="btn" @click="resetUa"><RotateCcw :size="12" />恢复默认</button>
      </div>
    </div>

    <div class="section-title">Cookie 注入白名单</div>
    <div class="set-row qk-col">
      <input v-model="hostsInput" class="qk-input" spellcheck="false" @blur="saveHosts" />
      <div class="qk-hint">
        推送直链时会把登录态一起交给 aria2,但**只发给这里列出的域名**(逗号分隔,支持子域)。
        夸克直链一般就在这些域下,默认的 <code>quark.cn</code> / <code>uc.cn</code> 通常够用;
        直链落在别的域名上、aria2 报 403 时,把面板「诊断」区显示的域名加进来。
        留空 = 不传 Cookie(aria2 会以游客身份请求,大文件很可能失败)。
      </div>
    </div>

    <div class="section-title">aria2 RPC</div>
    <div class="set-row">
      <span class="set-label">域名</span>
      <input class="qk-input sm" :value="state?.aria2.domain ?? ''" spellcheck="false" @blur="saveAria2('domain', ($event.target as HTMLInputElement).value)" />
      <span class="set-label">端口</span>
      <input class="qk-input xs" :value="state?.aria2.port ?? ''" spellcheck="false" @blur="saveAria2('port', ($event.target as HTMLInputElement).value)" />
      <span class="set-label">路径</span>
      <input class="qk-input sm" :value="state?.aria2.path ?? ''" spellcheck="false" @blur="saveAria2('path', ($event.target as HTMLInputElement).value)" />
    </div>
    <div class="set-row">
      <span class="set-label">令牌</span>
      <input class="qk-input" :value="state?.aria2.token ?? ''" spellcheck="false" @blur="saveAria2('token', ($event.target as HTMLInputElement).value)" />
      <span class="set-label">保存目录</span>
      <input class="qk-input" :value="state?.aria2.dir ?? ''" spellcheck="false" @blur="saveAria2('dir', ($event.target as HTMLInputElement).value)" />
      <button class="btn" :disabled="testing" @click="testAria2"><Wifi :size="12" />测试连接</button>
    </div>
    <div class="qk-hint">
      「推送 aria2」用 JSON-RPC 的 <code>aria2.addUri</code>,默认 <code>http://localhost:16800/jsonrpc</code>。
      保存目录留空表示交给 aria2 自己的配置。
    </div>

    <div v-if="notice" class="qk-notice">{{ notice }}</div>
  </section>
</template>

<style scoped>
.quark-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.qk-col {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}
.qk-input {
  min-width: 240px;
  flex: 1;
  padding: 4px 8px;
  border: 1px solid var(--border, #2a2d33);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 12px;
}
.qk-input.sm {
  min-width: 120px;
}
.qk-input.xs {
  min-width: 64px;
  flex: 0 0 64px;
}
.qk-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim, #9aa0a6);
}
.qk-hint code {
  color: var(--text, #e6e6e6);
}
.qk-notice {
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.12);
  font-size: 12px;
}
</style>
