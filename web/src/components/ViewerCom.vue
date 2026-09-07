<!-- Adapted from Stapxs QQ Lite ViewerCom.vue, AGPL-3.0-only. -->
<template>
  <Teleport to="body"><div ref="viewer" class="mask-background panel-viewer" role="dialog" aria-modal="true" aria-label="图片预览" @click="backdropClick" @wheel.prevent="zoom($event.deltaY < 0 ? .1 : -.1)">
    <div class="viewer-bar"><div class="viewer-tool-bar"><button class="icon-button" title="上一张" aria-label="上一张" :disabled="index <= 0" @click="step(-1)"><font-awesome-icon icon="arrow-left" /></button><button class="icon-button" title="缩小" aria-label="缩小" @click="zoom(-.2)"><font-awesome-icon icon="minus" /></button><button class="icon-button" title="还原尺寸" aria-label="还原尺寸" @click="reset"><font-awesome-icon icon="expand" /></button><button class="icon-button" title="放大" aria-label="放大" @click="zoom(.2)"><font-awesome-icon icon="plus" /></button><a class="icon-button" title="下载图片" aria-label="下载图片" :href="current + '?download=1'" download><font-awesome-icon icon="download" /></a><button class="icon-button" title="下一张" aria-label="下一张" :disabled="index >= gallery.length - 1" @click="step(1)"><font-awesome-icon icon="arrow-right" /></button><button ref="closeButton" class="icon-button" title="关闭" aria-label="关闭预览" @click="$emit('close')"><font-awesome-icon icon="xmark" /></button></div></div>
    <img ref="picture" class="viewer-img" :class="{ zoomed: scale > 1, dragging }" :src="current" alt="图片预览" draggable="false" :style="{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }" @dblclick="scale === 1 ? setScale(2) : reset()" @load="clampPan" @dragstart.prevent @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="stopDrag" @pointercancel="stopDrag" @lostpointercapture="stopDrag">
  </div></Teleport>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
const props = defineProps<{ images: string[]; url: string }>(), emit = defineEmits<{ close: [] }>()
const gallery = computed(() => props.images.includes(props.url) ? props.images : [props.url])
const index = ref(Math.max(0, gallery.value.indexOf(props.url))), scale = ref(1), closeButton = ref<HTMLButtonElement>()
const viewer = ref<HTMLDivElement>(), picture = ref<HTMLImageElement>(), pan = reactive({ x: 0, y: 0 }), dragging = ref(false)
let drag: { pointerId: number; x: number; y: number; panX: number; panY: number } | undefined, suppressClick = false
const current = computed(() => gallery.value[index.value] || props.url)
function clampPan() {
  if (!viewer.value || !picture.value) return
  const maxX = scale.value > 1 ? Math.max(0, (picture.value.offsetWidth * scale.value - viewer.value.clientWidth) / 2) : 0
  const maxY = scale.value > 1 ? Math.max(0, (picture.value.offsetHeight * scale.value - Math.max(0, viewer.value.clientHeight - 144)) / 2) : 0
  pan.x = Math.min(maxX, Math.max(-maxX, pan.x)); pan.y = Math.min(maxY, Math.max(-maxY, pan.y))
}
function stopDrag(event?: PointerEvent) {
  if (!drag || event && event.pointerId !== drag.pointerId) return
  const id = drag.pointerId; drag = undefined; dragging.value = false
  if (event?.type === 'pointercancel') suppressClick = false
  if (picture.value?.hasPointerCapture(id)) picture.value.releasePointerCapture(id)
}
function startDrag(event: PointerEvent) {
  suppressClick = false
  if (scale.value <= 1 || event.button !== 0 || !event.isPrimary || drag || !picture.value?.naturalWidth) return
  event.preventDefault()
  drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
  picture.value.setPointerCapture(event.pointerId); dragging.value = true
}
function moveDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return
  const x = event.clientX - drag.x, y = event.clientY - drag.y
  if (!suppressClick && Math.hypot(x, y) < 3) return
  suppressClick = true; pan.x = drag.panX + x; pan.y = drag.panY + y; clampPan()
}
function backdropClick(event: MouseEvent) {
  // Pointer capture can deliver the release click to the backdrop after a drag.
  if (suppressClick) { suppressClick = false; return }
  if (event.target === event.currentTarget) emit('close')
}
function setScale(value: number) {
  stopDrag()
  const next = Math.min(4, Math.max(.3, Math.round(value * 10) / 10)), ratio = next / scale.value
  scale.value = next; pan.x *= ratio; pan.y *= ratio; clampPan()
}
function zoom(amount: number) { setScale(scale.value + amount) }
function reset() { stopDrag(); scale.value = 1; pan.x = 0; pan.y = 0 }
function step(n: number) { index.value = Math.min(gallery.value.length - 1, Math.max(0, index.value + n)); reset() }
function resize() { stopDrag(); clampPan() }
function key(e: KeyboardEvent) { if (e.key === 'Escape') emit('close'); if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1) }
onMounted(() => { closeButton.value?.focus(); window.addEventListener('keydown', key); window.addEventListener('resize', resize) })
onUnmounted(() => { stopDrag(); window.removeEventListener('keydown', key); window.removeEventListener('resize', resize) })
</script>
