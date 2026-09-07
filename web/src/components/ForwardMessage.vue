<template>
  <details class="msg-forward" @toggle="toggle">
    <summary>合并转发消息<span v-if="item.content?.length"> · {{ item.content.length }} 条</span></summary>
    <template v-if="item.content?.length">
      <div v-for="(node, index) in item.content" :key="index" class="forward-msg">
        <b>{{ node.nickname || '未知发送者' }}</b>
        <div class="forward-node-content"><MessageContent :message="node.message" :owner="owner" :path="[...path, index]" @preview="$emit('preview', $event)" @image-loaded="$emit('imageLoaded')" /></div>
      </div>
    </template>
    <p v-else-if="loading" class="forward-status" role="status"><font-awesome-icon icon="spinner" spin /> 正在加载转发内容</p>
    <p v-else-if="error" class="forward-status error-text" role="alert">{{ error }}<button class="icon-button" title="重试" aria-label="重新加载转发消息" @click="load"><font-awesome-icon icon="rotate-right" /></button></p>
    <p v-else-if="!item.id" class="muted">此转发内容暂不可用</p>
  </details>
</template>
<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import type { Message, Segment } from '../types'
import { usePanel } from '../state/panel'
import MessageContent from './MessageContent.vue'
const props = defineProps<{ item: Segment; owner: Pick<Message, 'id' | 'bot_id'>; path: number[] }>()
defineEmits<{ preview: [url: string]; imageLoaded: [] }>()
const panel = usePanel(), loading = ref(false), error = ref('')
let controller: AbortController | undefined
async function load() {
  if (loading.value || props.item.content?.length || !props.item.id) return
  controller = new AbortController(); loading.value = true; error.value = ''
  try { await panel.loadForward(props.owner, props.path, controller.signal) }
  catch (e) { if ((e as Error).name !== 'AbortError') error.value = (e as Error).message }
  finally { loading.value = false }
}
function toggle(event: Event) { if ((event.currentTarget as HTMLDetailsElement).open) load() }
onUnmounted(() => controller?.abort())
</script>
