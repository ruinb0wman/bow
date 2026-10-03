<script setup lang="ts">
/**
 * 快捷键参考(bow://settings 的「快捷键」分区):
 * 只做分类展示 —— 无搜索框、无折叠、无副作用;数据全部来自 `@shared/shortcutCatalog`。
 * 这里**不注册任何热键**,真正识别按键的是主进程与各插件。
 */
import { SHORTCUT_GROUPS, SHORTCUT_INTRO } from '@shared/shortcutCatalog'
</script>

<template>
  <div class="sc-help">
    <p class="sc-intro">{{ SHORTCUT_INTRO }}</p>

    <section v-for="group in SHORTCUT_GROUPS" :key="group.id" class="sc-group">
      <h2 class="sc-group-title">{{ group.label }}</h2>
      <p v-if="group.hint" class="sc-group-hint">{{ group.hint }}</p>

      <ul class="sc-list">
        <li v-for="(item, i) in group.items" :key="`${group.id}-${i}`" class="sc-item">
          <span class="sc-keys">
            <template v-for="(k, ki) in item.keys" :key="`k${ki}`">
              <kbd>{{ k }}</kbd>
              <span v-if="ki < item.keys.length - 1" class="sc-plus">+</span>
            </template>
            <template v-for="(alt, ai) in item.alternatives ?? []" :key="`a${ai}`">
              <span class="sc-or">或</span>
              <span class="sc-alt">
                <template v-for="(k, ki) in alt" :key="`a${ai}-${ki}`">
                  <kbd>{{ k }}</kbd>
                  <span v-if="ki < alt.length - 1" class="sc-plus">+</span>
                </template>
              </span>
            </template>
          </span>

          <span class="sc-text">
            <span class="sc-label">{{ item.label }}</span>
            <span v-if="item.note" class="sc-note">{{ item.note }}</span>
            <span v-if="item.platformNote" class="sc-platform">{{ item.platformNote }}</span>
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.sc-help {
  padding: 4px 20px 24px;
  max-width: 920px;
}

.sc-intro {
  margin: 10px 0 4px;
  color: var(--fg-dim);
  font-size: 12px;
}

.sc-group {
  margin-top: 22px;
}

.sc-group-title {
  font-size: 13px;
  font-weight: 600;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.sc-group-hint {
  margin-top: 8px;
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.6;
}

.sc-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
}

.sc-item {
  display: flex;
  align-items: baseline;
  gap: 14px;
  padding: 8px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
}

.sc-item:last-child {
  border-bottom: none;
}

/* 按键列固定宽度,让右侧说明左边缘对齐 */
.sc-keys {
  flex: none;
  width: 220px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--bg3);
  color: var(--fg);
  white-space: nowrap;
}

.sc-plus,
.sc-or {
  color: var(--fg-dim);
  font-size: 11px;
}

.sc-or {
  padding: 0 2px;
}

.sc-alt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.sc-text {
  flex: 1;
  min-width: 0;
}

.sc-label {
  font-size: 13px;
}

.sc-note,
.sc-platform {
  display: block;
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--fg-dim);
}

.sc-platform {
  color: #e0a33e;
}
</style>
