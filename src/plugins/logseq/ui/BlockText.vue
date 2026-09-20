<script setup lang="ts">
/**
 * 把一行 markdown 渲染成 Vue 节点(**永不 `v-html`**)。
 *
 * 为什么不拼 HTML 字符串:`[[页面]]` / `#标签` 必须是**可点击的组件**(点击 = 应用内跳转),
 * 而且每个 token 都带原文区间(`srcStart`),点击时要把光标映射回原始 markdown 偏移。
 *
 * 递归:强调类 token 的 children 直接传进来(不重新 tokenize),所以嵌套里的引用一样可点。
 */
import { computed } from 'vue'
import { tokenizeInline, type Token } from '@plugins/logseq/format'

defineOptions({ name: 'BlockText' })

const props = defineProps<{ text?: string; tokens?: Token[] }>()
const emit = defineEmits<{
  (e: 'open-page', name: string): void
  (e: 'open-url', url: string): void
}>()

const list = computed<Token[]>(() => props.tokens ?? tokenizeInline(props.text ?? ''))

/** `[[a|b]]` 显示 b,点击时跳 a;`#[[多字 标签]]` 与 `#tag` 都显示去掉标记的名字 */
function label(token: Token): string {
  if (token.kind === 'page') return token.label
  if (token.kind === 'tag') return token.target
  if (token.kind === 'url') return token.label || token.href
  return token.raw
}
</script>

<template>
  <span class="block-text">
    <template v-for="(token, index) in list" :key="index">
      <span v-if="token.kind === 'text'" :data-src="token.srcStart">{{ token.raw }}</span>

      <strong v-else-if="token.kind === 'strong'" :data-src="token.srcStart">
        <BlockText :tokens="token.children" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
      </strong>

      <em v-else-if="token.kind === 'em'" :data-src="token.srcStart">
        <BlockText :tokens="token.children" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
      </em>

      <del v-else-if="token.kind === 'strike'" :data-src="token.srcStart">
        <BlockText :tokens="token.children" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
      </del>

      <mark v-else-if="token.kind === 'highlight'" :data-src="token.srcStart">
        <BlockText :tokens="token.children" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
      </mark>

      <code v-else-if="token.kind === 'code'" :data-src="token.srcStart">{{ token.children.map((c) => c.raw).join('') }}</code>

      <span
        v-else-if="token.kind === 'page'"
        class="wiki"
        :data-src="token.srcStart"
        :title="`打开页面 ${token.target}`"
        @click.stop="emit('open-page', token.target)"
        >{{ label(token) }}</span
      >

      <span
        v-else-if="token.kind === 'tag'"
        class="tag"
        :data-src="token.srcStart"
        :title="`打开页面 ${token.target}`"
        @click.stop="emit('open-page', token.target)"
        >{{ label(token) }}</span
      >

      <a
        v-else-if="token.kind === 'url'"
        class="link"
        :data-src="token.srcStart"
        :href="token.href"
        :title="token.href"
        @click.prevent.stop="emit('open-url', token.href)"
        >{{ label(token) }}</a
      >

      <span v-else :data-src="token.srcStart">{{ token.raw }}</span>
    </template>
  </span>
</template>

<style scoped>
.block-text {
  white-space: pre-wrap;
  word-break: break-word;
}

code {
  padding: 1px 4px;
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 0.92em;
  background: var(--bg3);
  border-radius: 3px;
}

.wiki,
.tag {
  color: var(--accent);
  cursor: pointer;
  border-radius: 3px;
}

.wiki:hover,
.tag:hover {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}

.tag {
  opacity: 0.9;
}

.link {
  color: #6ea8fe;
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

mark {
  background: color-mix(in srgb, var(--accent) 30%, transparent);
  color: inherit;
  border-radius: 3px;
}
</style>
