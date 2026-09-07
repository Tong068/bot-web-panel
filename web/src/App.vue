<!-- Derived from Stapxs QQ Lite App.vue (7a895b9), AGPL-3.0-only. -->
<template>
  <div v-if="panel.starting" class="boot"><font-awesome-icon icon="spinner" spin /></div>
  <div v-else-if="!panel.authenticated" class="home-body panel-login">
    <form class="login-pan-card ss-card" @submit.prevent="submitLogin">
      <img class="login-logo" src="/bot-web/img/icons/AppIcon.png" alt="Stapxs QQ Lite">
      <h1>机器人消息</h1><p class="muted">Stapxs QQ Lite UI</p>
      <label for="username">账号</label><input id="username" v-model="username" autocomplete="username" required>
      <label for="password">密码</label><input id="password" v-model="password" type="password" autocomplete="current-password" required>
      <p v-if="loginError" role="alert" class="error-text">{{ loginError }}</p>
      <button class="primary" :disabled="busy"><font-awesome-icon v-if="busy" icon="spinner" spin />登录</button>
    </form>
  </div>
  <div v-else id="base-app" class="panel-app" :class="{ 'mobile-chat': !!panel.current }">
    <div class="main-body">
      <ul id="side-bar" aria-label="导航">
        <li class="brand"><img src="/bot-web/img/icons/AppIcon.png" alt="机器人消息"></li>
        <li :class="{ active: view === 'messages' }"><button title="消息" aria-label="消息" @click="setView('messages')"><font-awesome-icon icon="envelope" /></button></li>
        <li :class="{ active: view === 'contacts' }"><button title="好友与群" aria-label="好友与群" @click="setView('contacts')"><font-awesome-icon icon="user" /></button></li>
        <li class="side-bar-space" />
        <li><button :title="preferences.dark ? '切换浅色' : '切换深色'" aria-label="切换主题" @click="preferences.toggleDark"><font-awesome-icon :icon="preferences.dark ? 'sun' : 'moon'" /></button></li>
        <li><button title="设置" aria-label="设置" @click="settingsDialog?.open()"><font-awesome-icon icon="gear" /></button></li>
        <li><button title="退出登录" aria-label="退出登录" @click="run(panel.logout)"><font-awesome-icon icon="arrow-right-from-bracket" /></button></li>
      </ul>
      <div class="workspace">
        <div class="friend-view">
          <div class="friend-list-container">
            <div id="message-list" class="friend-list">
              <div class="list-heading">
                <div class="base only"><span>{{ view === 'messages' ? '消息' : '好友与群' }}</span><div class="space" /><button class="icon-button" title="刷新" aria-label="刷新" @click="run(() => panel.refreshContacts())"><font-awesome-icon icon="rotate-right" /></button></div>
                <label class="bot-select"><Avatar :src="panel.currentBot?.avatar" alt="机器人头像" /><span class="sr-only">选择机器人</span><select :value="panel.activeBot" aria-label="选择机器人" @change="run(() => panel.switchBot(($event.target as HTMLSelectElement).value))"><option v-for="bot in panel.bots" :key="bot.id" :value="bot.id">{{ bot.name }} · {{ bot.id }}{{ bot.unread ? ` (${bot.unread})` : '' }}{{ bot.online ? '' : ' · 离线' }}</option></select></label>
                <div class="account-state"><i :class="{ online: panel.currentBot?.online }" /><span>{{ panel.currentBot?.adapter || '暂无机器人' }}</span><span class="connection" :class="{ disconnected: !panel.connected }">{{ panel.connected ? '已连接' : '重连中' }}</span></div>
                <label class="search"><font-awesome-icon icon="magnifying-glass" /><input v-model="search" placeholder="搜索会话" aria-label="搜索会话"></label>
                <div v-if="view === 'contacts'" class="tabs"><button :class="{ active: contactKind === 'all' }" @click="contactKind = 'all'">全部</button><button :class="{ active: contactKind === 'private' }" @click="contactKind = 'private'">好友</button><button :class="{ active: contactKind === 'group' }" @click="contactKind = 'group'">群聊</button></div>
              </div>
              <div id="message-list-body">
                <FriendBody v-for="item in visibleContacts" :key="item.key" v-context-menu="point => conversationMenu = { point, contact: item }" :data="friendData(item)" :select="panel.current?.key === item.key" :menu="conversationMenu?.contact.key === item.key" :from="view === 'messages' ? 'message' : 'friend'" tabindex="0" role="button" @click="panel.open(item)" @keydown.enter="panel.open(item)" />
                <p v-if="!visibleContacts.length" class="list-empty">{{ panel.bots.length ? '暂无会话' : '暂无已连接机器人' }}</p>
              </div>
            </div>
          </div>
        </div>
        <Chat v-if="panel.current" :key="panel.current.key" />
        <div v-else class="chat-empty"><img src="/bot-web/img/icons/AppIcon.png" alt=""><h2>{{ panel.currentBot?.name || '机器人消息' }}</h2><p>选择一个会话</p></div>
      </div>
    </div>
    <div v-if="panel.error" role="alert" class="toast"><span>{{ panel.error }}</span><button class="icon-button" title="关闭" aria-label="关闭提示" @click="panel.error = ''"><font-awesome-icon icon="xmark" /></button></div>
    <PanelSettings ref="settingsDialog" />
    <ContextMenu v-if="conversationMenu" :point="conversationMenu.point" :items="conversationItems" label="会话菜单" @select="conversationAction" @close="conversationMenu = undefined" />
    <ViewerCom v-if="avatarPreview" :url="avatarPreview" :images="[avatarPreview]" @close="avatarPreview = ''" />
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { usePanel } from './state/panel'
import FriendBody from './components/FriendBody.vue'
import Chat from './pages/Chat.vue'
import Avatar from './components/Avatar.vue'
import PanelSettings from './components/PanelSettings.vue'
import ContextMenu, { type MenuItem } from './components/ContextMenu.vue'
import ViewerCom from './components/ViewerCom.vue'
import { vContextMenu, type MenuPoint } from './function/contextMenu'
import { copyText } from './function/clipboard'
import { usePreferences } from './state/preferences'
import type { Contact } from './types'
const panel = usePanel(), username = ref('admin'), password = ref(''), loginError = ref(''), busy = ref(false)
const view = ref('messages'), search = ref(''), contactKind = ref('all'), settingsDialog = ref<InstanceType<typeof PanelSettings>>()
const preferences = usePreferences(), conversationMenu = ref<{ point: MenuPoint; contact: Contact }>(), avatarPreview = ref('')
watch(() => panel.activeBot, () => conversationMenu.value = undefined)
const visibleContacts = computed(() => (panel.contacts[panel.activeBot] || []).filter(x => (view.value !== 'messages' || preferences.sysConfig.session_display_mode === 'all' || x.last || x.pinned) && (contactKind.value === 'all' || view.value === 'messages' || x.kind === contactKind.value) && `${x.name} ${x.target_id} ${x.last?.preview || ''}`.toLowerCase().includes(search.value.toLowerCase())).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.last_seq || 0) - (a.last_seq || 0)))
const friendData = (c: Contact) => ({ ...c, ...(c.kind === 'group' ? { group_id: c.target_id, group_name: c.name } : { user_id: c.target_id, nickname: c.name }), time: c.last?.time, raw_msg: c.last?.recalled ? '[消息已撤回]' : c.last?.preview || '', longNick: c.target_id, new_msg: c.unread > 0, always_top: c.pinned })
const conversationItems = computed<MenuItem[]>(() => [
  { id: 'pin', label: conversationMenu.value?.contact.pinned ? '取消置顶' : '置顶', icon: 'thumbtack' },
  { id: 'read', label: '标记已读', icon: 'check' }, { id: 'unread', label: '标记未读', icon: 'flag' },
  { id: 'copy', label: '复制会话 ID', icon: 'copy' }, { id: 'avatar', label: '查看头像', icon: 'image', disabled: !conversationMenu.value?.contact.avatar }
])
async function conversationAction(id: string) {
  const contact = conversationMenu.value?.contact; if (!contact) return
  if (id === 'avatar') { avatarPreview.value = contact.avatar; return }
  await run(async () => {
    if (id === 'copy') await copyText(contact.target_id)
    else await panel.setConversation(contact, id === 'pin' ? { pinned: !contact.pinned } : { unread: id === 'unread' })
  })
}
async function run(fn: () => unknown) { try { await fn() } catch (e) { panel.error = (e as Error).message } }
function setView(value: string) { view.value = value; search.value = ''; if (innerWidth < 720) delete panel.selected[panel.activeBot] }
async function submitLogin() { busy.value = true; loginError.value = ''; try { await panel.login(username.value, password.value); password.value = '' } catch (e) { loginError.value = (e as Error).message } finally { busy.value = false } }
onMounted(panel.init)
</script>
