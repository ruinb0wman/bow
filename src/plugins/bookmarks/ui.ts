import StarButton from './ui/StarButton.vue'
import BookmarksButton from './ui/BookmarksButton.vue'
import BookmarksModal from './ui/BookmarksModal.vue'

export default {
  id: 'bookmarks',
  slots: {
    'addressbar-trailing': [StarButton],
    toolbar: [BookmarksButton]
  },
  overlays: [{ id: 'plugin:bookmarks:panel', component: BookmarksModal, placement: 'full' as const }]
}
