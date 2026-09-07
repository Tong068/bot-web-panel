<template>
  <Teleport to="body"><div ref="root" class="composer-popover" role="dialog" :aria-label="label" :style="position">
    <header class="picker-heading"><span>{{ label }}</span><button class="icon-button" :aria-label="'关闭' + label" title="关闭" @click="closeWithFocus"><font-awesome-icon icon="xmark" /></button></header>
    <slot />
  </div></Teleport>
</template>
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
const props = defineProps<{ anchor?: HTMLElement; label: string }>()
const emit = defineEmits<{ close: [] }>()
const root = ref<HTMLElement>(), position = ref<Record<string, string>>({ visibility: 'hidden' })
let observer: ResizeObserver | undefined
function place() {
  if (!props.anchor) return
  const rect = props.anchor.getBoundingClientRect(), viewport = window.visualViewport
  const x = viewport?.offsetLeft || 0, y = viewport?.offsetTop || 0, width = viewport?.width || innerWidth
  const bottom = Math.min(rect.top, y + (viewport?.height || innerHeight)) - 8
  const panelWidth = Math.max(0, Math.min(360, width - 16, rect.width - 16))
  position.value = { left: `${Math.max(x + 8, Math.min(rect.left + 10, x + width - panelWidth - 8))}px`, bottom: `${innerHeight - bottom}px`, width: `${panelWidth}px`, maxHeight: `${Math.max(0, bottom - y - 8)}px` }
}
function closeWithFocus() {
  const trigger = props.anchor?.querySelector<HTMLElement>('[aria-expanded="true"]')
  emit('close'); trigger?.focus({ preventScroll: true })
}
function outside(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target) && !props.anchor?.contains(event.target)) emit('close')
}
function keydown(event: KeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); closeWithFocus() } }
onMounted(() => {
  place(); observer = new ResizeObserver(place)
  if (props.anchor) { observer.observe(props.anchor); observer.observe(props.anchor.closest('.more') || props.anchor) }
  window.addEventListener('resize', place); window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place)
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keydown)
  if (matchMedia('(pointer: fine)').matches) root.value?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
})
onUnmounted(() => {
  observer?.disconnect(); window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place)
  document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keydown)
})
</script>
