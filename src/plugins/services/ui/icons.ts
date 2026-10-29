/**
 * 图标名 → lucide 组件。
 *
 * **静态命名 import**:`import * as` 会把 ~1500 个图标打进产物(1MB),而 `@ruinb0w/ui` 的
 * `registerIcons` 要给渲染层入口加登记,为这十来个图标不值。要加图标:这里加 import + 映射。
 *
 * 没登记的名字不白屏:回落 Play。
 */
import type { Component } from 'vue'
import {
  BookOpen,
  Bot,
  Boxes,
  Braces,
  Coins,
  Database,
  FlaskConical,
  Globe,
  Grid2x2,
  LayoutGrid,
  NotebookPen,
  Play,
  Server,
  Terminal
} from '@lucide/vue'

export const SERVICE_ICONS: Record<string, Component> = {
  Play,
  Server,
  Globe,
  Database,
  Coins,
  Bot,
  BookOpen,
  NotebookPen,
  LayoutGrid,
  Grid2x2,
  FlaskConical,
  Braces,
  Terminal,
  Boxes
}

/** 设置页下拉的取值顺序(与映射同源,加图标只改上面一处) */
export const SERVICE_ICON_NAMES: string[] = Object.keys(SERVICE_ICONS)

export function serviceIcon(name: string): Component {
  return SERVICE_ICONS[name] ?? Play
}
