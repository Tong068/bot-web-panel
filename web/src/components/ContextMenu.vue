<!-- Menu structure and classes adapted from Stapxs pages/Chat.vue, AGPL-3.0-only. -->
<template>
  <Teleport to="body"><div class="context-shade msg-menu-bg" @pointerdown.self="$emit('close')" @contextmenu.prevent="$emit('close')">
    <div ref="root" class="panel-context msg-menu-body show" role="menu" :aria-label="label" :style="{ left: left + 'px', top: top + 'px' }" @keydown="navigate" @contextmenu.stop.prevent>
      <component :is="item.href ? 'a' : 'button'" v-for="item in items" :key="item.id" role="menuitem" :href="item.href" :download="item.href ? '' : undefined" :disabled="item.disabled" :aria-disabled="item.disabled || undefined" @click="select(item)"><font-awesome-icon :icon="item.icon" /><span>{{ item.label }}</span></component>
    </div>
  </div></Teleport>
</template>
<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { MenuPoint } from '../function/contextMenu'
export interface MenuItem { id: string; label: string; icon: string; disabled?: boolean; href?: string }
const props = defineProps<{ point: MenuPoint; items: MenuItem[]; label?: string }>()
const emit = defineEmits<{ select: [id: string]; close: [] }>()
const root = ref<HTMLElement>(), left = ref(Math.max(8, Math.min(props.point.x, innerWidth - 232))), top = ref(Math.max(8, Math.min(props.point.y, innerHeight - Math.min(props.items.length * 40 + 12, innerHeight - 16) - 8))), previous = document.activeElement as HTMLElement | null
const targets = () => Array.from(root.value?.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])') || [])
function select(item: MenuItem) { if (!item.disabled) { emit('select', item.id); emit('close') } }
function navigate(event: KeyboardEvent) {
  if (['Escape', 'Tab'].includes(event.key)) { event.preventDefault(); emit('close'); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault(); const items = targets(), index = items.indexOf(document.activeElement as HTMLElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next]?.focus({ preventScroll: true })
}
const close = () => emit('close')
watch(() => [root.value, props.point, props.items], async () => {
  await nextTick(); const rect = root.value?.getBoundingClientRect(); if (!rect) return
  left.value = Math.max(8, Math.min(props.point.x, innerWidth - rect.width - 8)); top.value = Math.max(8, Math.min(props.point.y, innerHeight - rect.height - 8))
  if (!root.value?.contains(document.activeElement)) targets()[0]?.focus({ preventScroll: true })
}, { flush: 'post', immediate: true })
onMounted(() => window.addEventListener('resize', close))
onUnmounted(() => { window.removeEventListener('resize', close); if (previous?.isConnected && document.activeElement === document.body) previous.focus({ preventScroll: true }) })
</script>
