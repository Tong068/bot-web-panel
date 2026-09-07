import type { Directive } from 'vue'

export interface MenuPoint { x: number; y: number; selectedText?: string }
export function menuPoint(event: MouseEvent, element?: HTMLElement): MenuPoint {
  const selection = getSelection()
  const anchor = element || (event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined), rect = anchor?.getBoundingClientRect()
  const positioned = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX !== 0 || event.clientY !== 0)
  return { x: positioned ? event.clientX : (rect?.left || 0) + 20, y: positioned ? event.clientY : (rect?.top || 0) + 20, selectedText: selection?.anchorNode && (!element || element.contains(selection.anchorNode)) ? selection.toString() : '' }
}
type Handler = (point: MenuPoint) => void
const bindings = new WeakMap<HTMLElement, { handler: Handler; cleanup: () => void }>()
export const vContextMenu: Directive<HTMLElement, Handler> = {
  mounted(element, binding) {
    let timer: ReturnType<typeof setTimeout> | undefined, x = 0, y = 0, suppressedUntil = 0
    const state = { handler: binding.value, cleanup: () => {} }
    const cancel = () => { clearTimeout(timer); timer = undefined }
    const context = (event: MouseEvent) => { event.preventDefault(); cancel(); state.handler(menuPoint(event, element)) }
    const down = (event: PointerEvent) => {
      if (!['touch', 'pen'].includes(event.pointerType) || (event.target as Element).closest('button,a,input,textarea')) return
      cancel(); x = event.clientX; y = event.clientY
      timer = setTimeout(() => { suppressedUntil = Date.now() + 800; state.handler({ x, y }); timer = undefined }, 550)
    }
    const move = (event: PointerEvent) => { if (Math.hypot(event.clientX - x, event.clientY - y) > 10) cancel() }
    const click = (event: MouseEvent) => { if (Date.now() < suppressedUntil) { event.preventDefault(); event.stopImmediatePropagation() } }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      event.preventDefault(); const rect = element.getBoundingClientRect(); state.handler({ x: rect.left + 20, y: rect.top + 20 })
    }
    element.addEventListener('contextmenu', context); element.addEventListener('pointerdown', down); element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', cancel); element.addEventListener('pointercancel', cancel); element.addEventListener('click', click, true); element.addEventListener('keydown', key)
    state.cleanup = () => {
      cancel(); element.removeEventListener('contextmenu', context); element.removeEventListener('pointerdown', down); element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', cancel); element.removeEventListener('pointercancel', cancel); element.removeEventListener('click', click, true); element.removeEventListener('keydown', key)
    }
    bindings.set(element, state)
  },
  updated(element, binding) { const state = bindings.get(element); if (state) state.handler = binding.value },
  unmounted(element) { bindings.get(element)?.cleanup(); bindings.delete(element) }
}
