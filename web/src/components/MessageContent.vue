<!-- Message segments shared by ordinary messages and merged-forward nodes. -->
<template>
  <template v-for="(item, index) in message" :key="index">
    <span v-if="item.type === 'text' || item.type === 'markdown'" class="msg-text">{{ item.text }}</span>
    <span v-else-if="item.type === 'at'" class="msg-at" :title="item.qq">@{{ item.text?.replace(/^@/, '') || (item.qq === 'all' ? '全体成员' : item.qq) }}</span>
    <template v-else-if="item.type === 'reply'"><span v-if="!quoted" class="quote-text">引用内容暂不可用</span></template>
    <img v-else-if="item.type === 'face' && face(item.id)" class="msg-face" :src="face(item.id)?.url" :alt="face(item.id)?.name" :title="face(item.id)?.name">
    <template v-else-if="item.type === 'image'">
      <button v-if="item.url && preferences.sysConfig.opt_no_auto_load_image && !loaded[index]" class="msg-img-placeholder" @click="loaded[index] = true"><font-awesome-icon icon="image" />加载图片</button>
      <img v-else-if="item.url && !failed[index]" class="msg-img" :src="item.url" alt="图片" title="预览图片" loading="lazy" @load="$emit('imageLoaded')" @error="failed[index] = true" @click="$emit('preview', item.url)">
      <button v-else-if="item.url" class="msg-img-placeholder" @click="failed[index] = false"><font-awesome-icon icon="image" />重新加载图片</button><span v-else class="muted">[图片不可用]</span>
    </template>
    <div v-else-if="item.type === 'file'" class="msg-file" :class="{ me: outgoing }"><div><div><font-awesome-icon icon="folder" /></div><div><span>{{ item.name || '文件' }}</span><a v-if="item.url" :href="item.url + '?download=1'" target="_blank" rel="noopener">下载</a><span v-else>文件不可用</span></div></div></div>
    <video v-else-if="item.type === 'video' && item.url" :src="item.url" class="msg-video" controls playsinline preload="none" />
    <audio v-else-if="item.type === 'record' && item.url" :src="item.url" controls preload="none" />
    <ForwardMessage v-else-if="item.type === 'forward'" :item="item" :owner="owner" :path="[...path, index]" @preview="$emit('preview', $event)" @image-loaded="$emit('imageLoaded')" />
    <span v-else class="muted">[{{ labels[item.type] || item.type }}]</span>
  </template>
</template>
<script setup lang="ts">
import { reactive } from 'vue'
import type { Message, Segment } from '../types'
import emoji from '../emoji.json'
import { usePreferences } from '../state/preferences'
import ForwardMessage from './ForwardMessage.vue'
withDefaults(defineProps<{ message: Segment[]; owner: Pick<Message, 'id' | 'bot_id'>; path?: number[]; quoted?: boolean; outgoing?: boolean }>(), { path: () => [] })
defineEmits<{ preview: [url: string]; imageLoaded: [] }>()
const preferences = usePreferences(), failed = reactive<Record<number, boolean>>({}), loaded = reactive<Record<number, boolean>>({})
const face = (id?: string) => emoji.find(x => x.id === id)
const labels: Record<string, string> = { image: '图片', record: '语音', video: '视频', face: '表情', json: '卡片消息', xml: '卡片消息' }
</script>
