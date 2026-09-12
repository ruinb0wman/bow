/** 批量打开收藏页面(后台标签) */

import type { BookmarkNode } from '@shared/types'

interface TabApi {
  createTab: (url?: string, activate?: boolean) => Promise<{ id: number }>
}

/** 目录内全部书签以后台标签依次打开;返回打开数量(跳过子目录做防御) */
export async function openAllInFolder(api: TabApi, folder: BookmarkNode): Promise<number> {
  if (folder.type !== 'folder') return 0
  let count = 0
  for (const child of folder.children) {
    if (child.type !== 'bookmark') continue
    await api.createTab(child.url, false)
    count++
  }
  return count
}

/** 单本书签以后台标签打开 */
export function openBookmarkBackground(api: TabApi, url: string): void {
  void api.createTab(url, false)
}