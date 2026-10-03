<script setup lang="ts">
/**
 * 条目编辑器(嵌在密码面板里,不是独立弹层)。
 *
 * 只负责表单与密码生成;保存由父组件调 `plugins.invoke('passwords','save')` ——
 * 站点地址允许填完整 URL,主进程侧统一 `originOf()` 归一化(受信任的校验在那边)。
 */
import { reactive, ref, watch } from 'vue'
import { RefreshCw, Save, X } from 'lucide-vue-next'
import {
  DEFAULT_GENERATE_OPTIONS,
  generatePassword,
  type EntryDraft,
  type GenerateOptions
} from '../shared'

const props = defineProps<{ draft: EntryDraft; busy?: boolean; error?: string }>()
const emit = defineEmits<{ save: [draft: EntryDraft]; cancel: [] }>()

const form = reactive<EntryDraft>({ ...props.draft })
watch(
  () => props.draft,
  (d) => {
    form.id = d.id
    form.title = d.title
    form.origin = d.origin
    form.username = d.username
    form.password = d.password
    form.notes = d.notes
  }
)

const gen = reactive<GenerateOptions>({ ...DEFAULT_GENERATE_OPTIONS })
const genError = ref('')

function generate(): void {
  try {
    form.password = generatePassword(gen)
    genError.value = ''
  } catch (e) {
    genError.value = e instanceof Error ? e.message : String(e)
  }
}

function submit(): void {
  emit('save', {
    id: form.id,
    title: form.title.trim(),
    origin: form.origin.trim(),
    username: form.username,
    password: form.password,
    notes: form.notes
  })
}
</script>

<template>
  <form class="pe" @submit.prevent="submit">
    <div class="set-row">
      <span class="set-label">站点</span>
      <input
        v-model="form.origin"
        class="pe-input"
        placeholder="https://example.com 或完整登录页地址"
        spellcheck="false"
        autocomplete="off"
      />
    </div>
    <div class="set-row">
      <span class="set-label">名称</span>
      <input v-model="form.title" class="pe-input" placeholder="留空则取站点主机名" autocomplete="off" />
    </div>
    <div class="set-row">
      <span class="set-label">用户名</span>
      <input v-model="form.username" class="pe-input" spellcheck="false" autocomplete="off" />
    </div>
    <div class="set-row">
      <span class="set-label">密码</span>
      <input v-model="form.password" class="pe-input" spellcheck="false" autocomplete="off" />
      <button type="button" class="btn" title="生成强密码" @click="generate">
        <RefreshCw :size="12" />生成
      </button>
    </div>

    <div class="pe-gen">
      <label class="set-check"><input v-model.number="gen.length" type="range" min="8" max="64" step="1" />长度 {{ gen.length }}</label>
      <label class="set-check"><input v-model="gen.lower" type="checkbox" />小写</label>
      <label class="set-check"><input v-model="gen.upper" type="checkbox" />大写</label>
      <label class="set-check"><input v-model="gen.digits" type="checkbox" />数字</label>
      <label class="set-check"><input v-model="gen.symbols" type="checkbox" />符号</label>
      <label class="set-check"><input v-model="gen.avoidAmbiguous" type="checkbox" />避开易混字符</label>
    </div>
    <div v-if="genError" class="pe-error">{{ genError }}</div>

    <div class="set-row pe-notes">
      <span class="set-label">备注</span>
      <textarea v-model="form.notes" class="pe-input" rows="2" autocomplete="off" />
    </div>

    <div v-if="error" class="pe-error">{{ error }}</div>

    <div class="pe-actions">
      <button type="button" class="btn" @click="emit('cancel')"><X :size="12" />取消</button>
      <button type="submit" class="btn primary" :disabled="busy"><Save :size="12" />保存</button>
    </div>
  </form>
</template>

<style scoped>
.pe {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pe-input {
  flex: 1;
  min-width: 0;
}
.pe-gen {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 4px 14px 8px;
  color: var(--fg-dim);
  font-size: 12px;
}
.pe-notes {
  align-items: flex-start;
}
.pe-error {
  padding: 0 14px 6px;
  color: var(--danger);
  font-size: 12px;
}
.pe-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 6px 14px 12px;
}
</style>
