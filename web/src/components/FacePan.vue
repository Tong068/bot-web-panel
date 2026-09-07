<!-- Stapxs FacePan's local QFace grid, adapted for the framework message composer. -->
<template><div class="face-pan" @keydown="navigate"><label class="search"><input v-model="query" aria-label="搜索表情" placeholder="搜索表情"></label><div ref="grid" class="face-grid"><button v-for="item in faces" :key="item.id" type="button" :title="item.name || '表情 ' + item.id" :aria-label="item.name || '表情 ' + item.id" @click="$emit('select', item.id)"><img :src="item.url" :alt="item.name || '表情 ' + item.id" loading="lazy"></button></div><p v-if="!faces.length" class="picker-status" role="status">没有匹配的表情</p></div></template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import emoji from '../emoji.json'
defineEmits<{ select: [id: string] }>()
const query = ref(''), grid = ref<HTMLElement>(), faces = computed(() => emoji.filter(x => x.name.includes(query.value.trim()) || x.id === query.value.trim()))
function navigate(event: KeyboardEvent) {
  if (event.isComposing || !grid.value) return
  const buttons = Array.from(grid.value.querySelectorAll('button')), index = buttons.indexOf(event.target as HTMLButtonElement)
  if (index < 0) { if (event.key === 'ArrowDown') { event.preventDefault(); buttons[0]?.focus() } return }
  const columns = getComputedStyle(grid.value).gridTemplateColumns.split(' ').length
  const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, ArrowDown: index + columns, ArrowUp: index - columns, Home: 0, End: buttons.length - 1 }
  if (event.key in moves) { event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, moves[event.key]))]?.focus() }
}
</script>
