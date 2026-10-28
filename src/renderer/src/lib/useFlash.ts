import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue'

/**
 * 一次性提示条(设置页/面板里那句「已保存」「已导出」):
 * `flash(text)` 写一条,`defaultMs` 后自动清掉;新提示顶掉旧的。
 * 作用域销毁时清 timer,调用方不用再在 onBeforeUnmount 里操心。
 */
export function useFlash(defaultMs = 2200): {
  notice: Ref<string>
  flash: (text: string, ms?: number) => void
} {
  const notice = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined

  function flash(text: string, ms = defaultMs): void {
    notice.value = text
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      notice.value = ''
      timer = undefined
    }, ms)
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  return { notice, flash }
}
