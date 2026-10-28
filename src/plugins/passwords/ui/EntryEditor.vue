<script setup lang="ts">
/**
 * 条目编辑器(嵌在密码面板里,不是独立弹层)。
 *
 * 只负责表单与密码生成;保存由父组件调 `plugins.invoke('passwords','save')` ——
 * 站点地址允许填完整 URL,主进程侧统一 `originOf()` 归一化(受信任的校验在那边)。
 */
import { RButton, RCheckbox, RFormRow } from '@ruinb0w/ui'
import { reactive, ref, watch } from 'vue'
import { RefreshCw, Save, X } from '@lucide/vue'
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
    <RFormRow label="站点">
      <input
        v-model="form.origin"
        class="pe-input"
        placeholder="https://example.com 或完整登录页地址"
        spellcheck="false"
        autocomplete="off"
      />
    </RFormRow>
    <RFormRow label="名称">
      <input v-model="form.title" class="pe-input" placeholder="留空则取站点主机名" autocomplete="off" />
    </RFormRow>
    <RFormRow label="用户名">
      <input v-model="form.username" class="pe-input" spellcheck="false" autocomplete="off" />
    </RFormRow>
    <RFormRow label="密码">
      <input v-model="form.password" class="pe-input" spellcheck="false" autocomplete="off" />
      <RButton size="small" title="生成强密码" @click="generate">
        <RefreshCw :size="12" />生成
      </RButton>
    </RFormRow>

    <div class="pe-gen">
      <label class="set-check"><input v-model.number="gen.length" type="range" min="8" max="64" step="1" />长度 {{ gen.length }}</label>
      <RCheckbox v-model="gen.lower" label="小写" />
      <RCheckbox v-model="gen.upper" label="大写" />
      <RCheckbox v-model="gen.digits" label="数字" />
      <RCheckbox v-model="gen.symbols" label="符号" />
      <RCheckbox v-model="gen.avoidAmbiguous" label="避开易混字符" />
    </div>
    <div v-if="genError" class="pe-error">{{ genError }}</div>

    <RFormRow label="备注" align="start">
      <textarea v-model="form.notes" class="pe-input" rows="2" autocomplete="off" />
    </RFormRow>

    <div v-if="error" class="pe-error">{{ error }}</div>

    <div class="pe-actions">
      <RButton size="small" @click="emit('cancel')"><X :size="12" />取消</RButton>
      <RButton size="small" type="primary" native-type="submit" :disabled="busy"><Save :size="12" />保存</RButton>
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
