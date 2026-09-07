<!-- Adapted from Stapxs QQ Lite MsgBody.vue (Stapxs, 7a895b9), AGPL-3.0-only.
     The original message/header/segment DOM and msg.css are retained; data comes from the framework bridge. -->
<template>
  <div :id="'chat-' + data.id" v-context-menu="point => $emit('showMenu', point, data)" class="message" :class="{ me: isMe, right: isMe && preferences.sysConfig.opt_ind_message, recalled: data.recalled }" :data-sender="data.sender.user_id" :data-time="data.time" tabindex="0">
    <Avatar name="avatar" :src="avatar || data.sender.avatar" :alt="data.sender.nickname + '头像'" title="查看头像" @click="showAvatar" />
    <div v-if="data.status === 'sending'" class="sending left me"><font-awesome-icon icon="spinner" spin /></div>
    <div class="message-body" :class="{ me: isMe, right: isMe && preferences.sysConfig.opt_ind_message }">
      <header><span v-if="data.sender.role === 'owner'" class="owner">群主</span><span v-else-if="data.sender.role === 'admin'" class="admin">管理员</span><span v-if="data.origin === 'plugin'" class="robot">机器人</span><a>{{ data.sender.nickname || data.sender.user_id }}</a><a class="time">{{ formatSessionTime(data.time) }}</a><button class="message-menu" title="消息操作" aria-label="消息操作" @click="$emit('showMenu', menuPoint($event), data)"><font-awesome-icon icon="chevron-down" /></button></header>
      <div v-if="data.recalled" class="recalled-text">消息已撤回</div>
      <div v-else>
        <blockquote v-if="data.quote" class="quote-text"><font-awesome-icon icon="reply" /> {{ data.quote.text || '引用内容暂不可用' }}</blockquote>
        <span v-if="!data.message.length" class="msg-text muted">空消息</span>
        <MessageContent :message="data.message" :owner="data" :quoted="!!data.quote" :outgoing="isMe" @preview="$emit('preview', $event)" @image-loaded="$emit('imageLoaded')" />
      </div>
      <small v-if="isMe" class="delivery" :class="{ failed: ['failed', 'partial', 'unknown'].includes(data.status) }">{{ statuses[data.status] || data.status }}</small>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '../types'
import { formatSessionTime } from '../function/utils/systemUtil'
import MessageContent from './MessageContent.vue'
import Avatar from './Avatar.vue'
import { usePreferences } from '../state/preferences'
import { menuPoint, vContextMenu, type MenuPoint } from '../function/contextMenu'
const props = defineProps<{ data: Message; avatar?: string }>()
const emit = defineEmits<{ showMenu: [point: MenuPoint, data: Message]; preview: [url: string]; imageLoaded: [] }>()
const preferences = usePreferences(), isMe = computed(() => props.data.direction === 'out')
const statuses: Record<string, string> = { sending: '发送中', sent: '已发送', failed: '发送失败', partial: '部分发送失败', unknown: '发送结果未确认' }
function showAvatar() { const url = props.avatar || props.data.sender.avatar; if (url) emit('preview', url) }
</script>
