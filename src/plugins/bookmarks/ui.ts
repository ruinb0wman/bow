import StarButton from './ui/StarButton.vue'
import BookmarksButton from './ui/BookmarksButton.vue'
import BookmarksModal from './ui/BookmarksModal.vue'

/**
 * 书签插件没有设置分区:原先的「导出/导入书签」已并入设置页的核心「备份」分区(整包备份/还原),
 * 单插件 JSON 导入导出随之下线(见 `.pi/plans/2026-11-05-backup-restore/plan.md`)。
 */
export default {
  id: 'bookmarks',
  slots: {
    'addressbar-trailing': [StarButton],
    toolbar: [BookmarksButton]
  },
  overlays: [{ id: 'plugin:bookmarks:panel', component: BookmarksModal, placement: 'full' as const }]
}
