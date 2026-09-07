<!-- Adapted from Stapxs QQ Lite pages/Chat.vue (Stapxs, 7a895b9), AGPL-3.0-only.
     Retains the chat-pan, header, message area, reply/at tags and composer structure. -->
<template>
  <div id="chat-pan" class="chat-pan" @dragover.prevent @drop.prevent="dropFiles">
    <div class="info"><button class="icon-button back" title="返回" aria-label="返回会话列表" @click="delete panel.selected[panel.activeBot]"><font-awesome-icon icon="angle-left" /></button><Avatar :src="panel.current?.avatar" alt="会话头像" title="查看会话头像" tabindex="0" @click="preview = panel.current?.avatar || ''" @keydown.enter="preview = panel.current?.avatar || ''" /><div class="info"><p>{{ panel.current?.name }}</p><span>{{ panel.current?.kind === 'group' ? '群聊' : '私聊' }} · {{ panel.current?.target_id }}</span></div><div class="space" /><span class="chat-bot-name">{{ panel.currentBot?.name }}</span><button class="icon-button" title="搜索当前消息" aria-label="搜索当前消息" @click="showSearch = !showSearch"><font-awesome-icon icon="magnifying-glass" /></button></div>
    <label v-if="showSearch" class="chat-search search"><font-awesome-icon icon="magnifying-glass" /><input v-model="query" placeholder="搜索已加载的消息" aria-label="搜索已加载的消息"></label>
    <div ref="scroller" id="msgPan" class="chat" @scroll="onScroll">
      <div class="history-control"><button v-if="panel.hasMore" :disabled="panel.loading" @click="loadOlder">加载更早消息</button><span v-else>没有更早记录</span></div>
      <p v-if="panel.loading && !panel.messages.length" class="list-empty"><font-awesome-icon icon="spinner" spin /></p>
      <p v-else-if="!panel.messages.length" class="list-empty">暂无消息</p>
      <div class="message-items"><MsgBody v-for="message in filtered" :key="message.id" :data="message" :avatar="message.direction === 'out' ? panel.currentBot?.avatar : undefined" @show-menu="showMenu" @preview="preview = $event" @image-loaded="scrollBottom(false)" /></div>
    </div>
    <button v-if="!atBottom" class="new-messages" @click="scrollBottom(true)"><font-awesome-icon icon="chevron-down" /> 最新消息</button>
    <div class="more">
      <div class="composer-extras">
        <div v-if="panel.draft.quote" class="replay-tag show"><font-awesome-icon icon="reply" /><span>{{ panel.draft.quote.sender.nickname }}: {{ panel.draft.quote.preview }}</span><button class="icon-button" title="取消引用" aria-label="取消引用" @click="panel.draft.quote = undefined"><font-awesome-icon icon="xmark" /></button></div>
        <div v-if="panel.draft.attachments.length || panel.draft.mentions.length || panel.draft.faces.length" class="attachment-list">
          <div v-for="(file, index) in panel.draft.attachments" :key="file.id" class="attachment"><img v-if="file.type === 'image'" :src="file.url" :alt="file.name"><font-awesome-icon v-else icon="folder" /><span>{{ file.name }}</span><button class="icon-button" title="移除附件" aria-label="移除附件" @click="panel.draft.attachments.splice(index, 1)"><font-awesome-icon icon="xmark" /></button></div>
          <button v-for="(member, index) in panel.draft.mentions" :key="member.user_id" class="mention-chip" @click="panel.draft.mentions.splice(index, 1)">@{{ member.nickname }} ×</button>
          <button v-for="(id, index) in panel.draft.faces" :key="index" class="mention-chip" @click="panel.draft.faces.splice(index, 1)"><img :src="emoji.find(x => x.id === id)?.url" alt="表情"> ×</button>
        </div>
        <div ref="toolbar" class="more-detail show"><button class="icon-button" title="图片" aria-label="发送图片" :disabled="!canSend || uploading" @click="closePickers(); imageInput?.click()"><font-awesome-icon icon="image" /></button><button class="icon-button" :title="panel.cap.file ? '文件' : '此机器人不支持文件'" aria-label="发送文件" :disabled="!canSend || !panel.cap.file || uploading" @click="closePickers(); fileInput?.click()"><font-awesome-icon icon="folder" /></button><button class="icon-button" title="表情" aria-label="表情" aria-haspopup="dialog" :aria-expanded="showFaces" :disabled="!canSend" @click="toggleFaces"><font-awesome-icon icon="face-laugh" /></button><button v-if="panel.current?.kind === 'group'" class="icon-button" :title="panel.cap.at ? '@成员' : '此机器人不支持 @成员'" aria-label="@成员" aria-haspopup="dialog" :aria-expanded="showMembers" :disabled="!canSend || !panel.cap.at" @click="openMembers"><font-awesome-icon icon="at" /></button><span v-if="uploading" class="muted"><font-awesome-icon icon="spinner" spin /> 上传中</span><div class="space" /><span v-if="!panel.currentBot?.online" class="error-text">机器人离线</span></div>
        <ComposerPopover v-if="showFaces || showMembers" :key="showFaces ? 'faces' : 'members'" :anchor="toolbar" :label="showFaces ? '表情' : '@成员'" @close="closePickers">
          <FacePan v-if="showFaces" @select="selectFace" />
          <div v-else class="at-tag show member-picker">
            <label class="search"><input v-model="memberQuery" placeholder="成员名称或 ID" aria-label="成员名称或 ID" @keydown.down.prevent="memberOptions?.querySelector('button')?.focus()" @keydown.enter="selectMatchingMember"></label>
            <p v-if="memberLoading" class="picker-status" role="status"><font-awesome-icon icon="spinner" spin /> 正在加载成员</p>
            <div v-else ref="memberOptions" class="member-options" @keydown="navigateMembers"><button v-for="member in matchingMembers" :key="member.user_id" :title="member.nickname + ' · ' + member.user_id" @click="mention(member)"><span>{{ member.nickname }}</span><small>{{ member.user_id }}</small></button></div>
            <p v-if="!memberLoading && memberError" class="picker-status error-text" role="alert">{{ memberError }}<button v-if="panel.cap.members" class="icon-button" title="重试" aria-label="重新加载成员" @click="loadMembers"><font-awesome-icon icon="rotate-right" /></button></p>
            <p v-else-if="!memberLoading && !matchingMembers.length" class="picker-status" role="status">{{ memberQuery.trim() ? '没有匹配的成员' : '暂无成员' }}</p>
            <button v-if="manualMember" class="manual-member" @click="mention(manualMember)">@ ID: {{ manualMember.user_id }}</button>
          </div>
        </ComposerPopover>
      </div>
      <div class="composer-row"><div class="input-holder"><form @submit.prevent="send"><label class="sr-only" for="main-input-ex">消息输入框</label><textarea id="main-input-ex" ref="input" v-model="panel.draft.text" rows="2" maxlength="20000" :disabled="!canSend" placeholder="发送消息" aria-label="消息输入框" @paste="paste" @keydown="keyDown" /></form><button class="icon-button send-button" title="发送" aria-label="发送消息" :disabled="!canSend || sending || uploading" @click="send"><font-awesome-icon :icon="sending ? 'spinner' : 'paper-plane'" :spin="sending" /></button></div></div>
    </div>
    <input ref="imageInput" class="hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" multiple @change="choose($event, 'image')"><input ref="fileInput" class="hidden" type="file" multiple @change="choose($event, 'file')">
    <ContextMenu v-if="menu" :point="menu.point" :items="menuItems" label="消息菜单" @select="menuAction" @close="menu = undefined" />
    <ViewerCom v-if="preview" :url="preview" :images="images" @close="preview = ''" />
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { usePanel } from '../state/panel'
import type { Message, Segment } from '../types'
import MsgBody from '../components/MsgBody.vue'
import ViewerCom from '../components/ViewerCom.vue'
import FacePan from '../components/FacePan.vue'
import emoji from '../emoji.json'
import Avatar from '../components/Avatar.vue'
import ContextMenu, { type MenuItem } from '../components/ContextMenu.vue'
import ComposerPopover from '../components/ComposerPopover.vue'
import type { MenuPoint } from '../function/contextMenu'
import { copyText, messageText } from '../function/clipboard'
import { usePreferences } from '../state/preferences'
const panel = usePanel(), scroller = ref<HTMLDivElement>(), input = ref<HTMLTextAreaElement>(), imageInput = ref<HTMLInputElement>(), fileInput = ref<HTMLInputElement>()
const showFaces = ref(false), showMembers = ref(false), showSearch = ref(false), uploading = ref(false), query = ref(''), preview = ref(''), atBottom = ref(true), memberQuery = ref(''), memberError = ref('')
const members = ref<{ user_id: string; nickname: string }[]>([]), menu = ref<{ point: MenuPoint; message: Message }>(), preferences = usePreferences()
const toolbar = ref<HTMLElement>(), memberOptions = ref<HTMLElement>(), memberLoading = ref(false)
let memberController: AbortController | undefined, memberGeneration = 0
const sending = computed(() => !!panel.sending[panel.current?.key || '']), canSend = computed(() => !!panel.currentBot?.online && panel.cap.text)
const filtered = computed(() => panel.messages.filter(x => `${x.preview} ${x.sender.nickname}`.toLowerCase().includes(query.value.toLowerCase())))
const imageUrls = (message: Segment[]): string[] => message.flatMap(part => part.type === 'image' && part.url ? [part.url] : part.type === 'forward' ? (part.content || []).flatMap(node => imageUrls(node.message)) : [])
const images = computed(() => panel.messages.flatMap(m => imageUrls(m.message)))
const matchingMembers = computed(() => members.value.filter(x => `${x.nickname} ${x.user_id}`.toLowerCase().includes(memberQuery.value.trim().toLowerCase())))
const manualMember = computed(() => !memberLoading.value && !matchingMembers.value.length && /^[\w:.-]{1,512}$/.test(memberQuery.value.trim()) ? { user_id: memberQuery.value.trim(), nickname: memberQuery.value.trim() } : undefined)
const menuItems = computed<MenuItem[]>(() => {
  const message = menu.value?.message; if (!message) return []
  const items: MenuItem[] = [{ id: 'reply', label: '回复', icon: 'reply', disabled: !panel.cap.quote || !message.platform_id || message.recalled }, { id: 'copy', label: '复制', icon: 'copy' }]
  if (menu.value?.point.selectedText) items.push({ id: 'selection', label: '复制选中文本', icon: 'copy' })
  if (panel.current?.kind === 'group' && message.direction !== 'out') items.push({ id: 'at', label: '@发送者', icon: 'at', disabled: !canSend.value || !panel.cap.at })
  items.push({ id: 'sender-id', label: '复制发送者 ID', icon: 'user' })
  if (message.platform_id) items.push({ id: 'message-id', label: '复制消息 ID', icon: 'copy' })
  message.message.forEach((part, index) => { if (part.url && ['image', 'file', 'record', 'video'].includes(part.type)) items.push({ id: `download-${index}`, label: `下载${part.type === 'image' ? '图片' : part.name || '附件'}`, icon: 'download', href: `${part.url}?download=1` }) })
  if (message.direction === 'out') items.push({ id: 'recall', label: '撤回', icon: 'trash-can', disabled: !panel.cap.recall || !message.platform_id || message.recalled })
  return items
})
async function run(fn: () => unknown) { try { await fn() } catch (e) { panel.error = (e as Error).message } }
function onScroll() { const el = scroller.value; if (el) atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }
async function scrollBottom(force: boolean) { await nextTick(); if ((force || atBottom.value) && scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight }
watch(() => panel.messages.length, () => scrollBottom(false)); watch(() => panel.loading, value => { if (!value && atBottom.value) scrollBottom(true) })
async function loadOlder() { const el = scroller.value, height = el?.scrollHeight || 0; await run(panel.older); await nextTick(); if (el) el.scrollTop = el.scrollHeight - height }
async function send() { await run(panel.send); await scrollBottom(true); input.value?.focus() }
function keyDown(e: KeyboardEvent) { if (preferences.isSendKey(e)) { e.preventDefault(); if (canSend.value && !sending.value && !uploading.value) send() } }
async function files(list: File[], type?: 'image' | 'file') { const contact = panel.current, canFile = panel.cap.file; if (!contact || !canSend.value || uploading.value) return; uploading.value = true; await run(async () => { for (const file of list) { const kind = type || (file.type.startsWith('image/') ? 'image' : 'file'); if (kind === 'file' && !canFile) throw new Error('此机器人不支持文件发送'); await panel.upload(file, kind, contact) } }); uploading.value = false }
function choose(e: Event, type: 'image' | 'file') { const el = e.target as HTMLInputElement; files(Array.from(el.files || []), type); el.value = '' }
function dropFiles(e: DragEvent) { files(Array.from(e.dataTransfer?.files || [])) }
function paste(e: ClipboardEvent) { const list = Array.from(e.clipboardData?.files || []); if (list.length) { e.preventDefault(); files(list) } }
function showMenu(point: MenuPoint, message: Message) { menu.value = { point, message } }
async function menuAction(id: string) {
  const selected = menu.value; if (!selected) return
  const message = selected.message
  if (id === 'reply') { panel.draft.quote = message; await nextTick(); input.value?.focus(); return }
  if (id === 'at') { mention({ user_id: message.sender.user_id, nickname: message.sender.nickname }); return }
  await run(async () => {
    if (id === 'copy') await copyText(messageText(message))
    if (id === 'selection') await copyText(selected.point.selectedText || '')
    if (id === 'sender-id') await copyText(message.sender.user_id)
    if (id === 'message-id') await copyText(message.platform_id || '')
    if (id === 'recall') await panel.recall(message)
  })
}
function closePickers() { memberGeneration++; memberController?.abort(); showFaces.value = false; showMembers.value = false; memberLoading.value = false }
function toggleFaces() { const open = !showFaces.value; closePickers(); showFaces.value = open }
async function selectFace(id: string) { panel.draft.faces.push(id); closePickers(); await nextTick(); input.value?.focus() }
function openMembers() {
  const open = !showMembers.value; closePickers()
  if (!open || !panel.cap.at || !panel.current) return
  members.value = []; memberQuery.value = ''; memberError.value = ''; showMembers.value = true; loadMembers()
}
async function loadMembers() {
  const contact = panel.current; if (!contact || !showMembers.value) return
  memberController?.abort(); const controller = new AbortController(), generation = ++memberGeneration
  memberController = controller; members.value = []; memberError.value = ''
  if (!panel.cap.members) { memberError.value = '此机器人不提供成员列表'; return }
  memberLoading.value = true
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const result = await panel.action<{ user_id: string; nickname: string }[]>('get_group_member_list', { target_id: contact.target_id }, contact.bot_id, controller.signal)
    if (generation === memberGeneration && panel.current?.key === contact.key) members.value = result
  } catch (e) { if (generation === memberGeneration) memberError.value = controller.signal.aborted ? '成员查询超时，请重试' : (e as Error).message }
  finally { clearTimeout(timeout); if (generation === memberGeneration) memberLoading.value = false }
}
async function mention(member: { user_id: string; nickname: string }) {
  if (!canSend.value || !panel.cap.at) return
  if (!panel.draft.mentions.some(item => item.user_id === member.user_id)) panel.draft.mentions.push(member)
  closePickers(); await nextTick(); input.value?.focus()
}
function selectMatchingMember(event: KeyboardEvent) { if (!event.isComposing && !memberLoading.value && matchingMembers.value[0]) { event.preventDefault(); mention(matchingMembers.value[0]) } }
function navigateMembers(event: KeyboardEvent) {
  const buttons = Array.from(memberOptions.value?.querySelectorAll('button') || []), index = buttons.indexOf(event.target as HTMLButtonElement)
  const moves: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 }
  if (index >= 0 && event.key in moves) { event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, moves[event.key]))]?.focus() }
}
function escape(e: KeyboardEvent) { if (e.key === 'Escape') menu.value = undefined }
onMounted(() => { scrollBottom(true); window.addEventListener('keydown', escape) }); onUnmounted(() => { closePickers(); window.removeEventListener('keydown', escape) })
</script>
