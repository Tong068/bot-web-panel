<!-- Adapted from Stapxs OptView.vue / OptFunction.vue (Stapx Steve, 7a895b9).
     Original opt-item, ss-switch and ss-radio structures and settings keys are retained. -->
<template>
  <dialog ref="dialog" class="settings-dialog" aria-label="设置">
    <div class="dialog-heading"><h2>设置</h2><button class="icon-button" title="关闭" aria-label="关闭设置" @click="dialog?.close()"><font-awesome-icon icon="xmark" /></button></div>
    <div class="settings-tabs" role="tablist" aria-label="设置分类"><button v-for="item in tabs" :key="item.id" role="tab" :aria-selected="tab === item.id" :class="{ active: tab === item.id }" @click="tab = item.id">{{ item.name }}</button></div>
    <div v-if="tab === 'view'" class="opt-page" role="tabpanel">
      <section class="settings-section"><header>主题与颜色</header>
        <div class="opt-item"><div /><font-awesome-icon icon="moon" /><div><label for="opt-view-dark">深色模式</label></div><label class="ss-switch"><input id="opt-view-dark" v-model="preferences.sysConfig.opt_dark" type="checkbox" :disabled="preferences.sysConfig.opt_auto_dark"><div><div /></div></label></div>
        <div class="opt-item"><div /><font-awesome-icon icon="circle" /><div><label for="opt-view-auto-dark">自动深色模式</label></div><label class="ss-switch"><input id="opt-view-auto-dark" v-model="preferences.sysConfig.opt_auto_dark" type="checkbox"><div><div /></div></label></div>
        <div class="opt-item theme-option"><div /><font-awesome-icon icon="circle" /><div><span>主题色</span></div><div class="theme-color-col" role="radiogroup" aria-label="主题色"><label v-for="(name, index) in preferences.colorNames" :key="index" :title="name" class="ss-radio"><input v-model="preferences.sysConfig.theme_color" type="radio" name="theme_color" :value="index" :aria-label="name"><div :style="{ background: `var(--color-main-${index})` }"><div /></div></label></div></div>
      </section>
      <section class="settings-section"><header>消息页面</header>
        <div class="opt-item"><div /><font-awesome-icon icon="envelope" /><div><label for="opt-view-ind-message">独立显示消息</label></div><label class="ss-switch"><input id="opt-view-ind-message" v-model="preferences.sysConfig.opt_ind_message" type="checkbox"><div><div /></div></label></div>
        <div class="opt-item"><div /><font-awesome-icon icon="user-group" /><div><label for="opt-function-session-display-mode">会话显示</label></div><div class="select-wrapper"><select id="opt-function-session-display-mode" v-model="preferences.sysConfig.session_display_mode"><option value="recent">最近会话</option><option value="all">全部会话</option></select></div></div>
      </section>
    </div>
    <div v-else-if="tab === 'chat'" class="opt-page" role="tabpanel">
      <section class="settings-section"><header>聊天选项</header>
        <div class="opt-item"><div /><font-awesome-icon icon="paper-plane" /><div><label for="opt-function-send-key">发送键</label></div><div class="select-wrapper"><select id="opt-function-send-key" v-model="preferences.sysConfig.send_key"><option value="none">Enter</option><option value="shift">Shift + Enter</option><option value="ctrl">Ctrl + Enter</option><option value="alt">Alt + Enter</option><option value="meta">Meta + Enter</option></select></div></div>
        <div class="opt-item"><div /><font-awesome-icon icon="image" /><div><label for="opt-function-no-auto-load-image">不自动加载图片</label></div><label class="ss-switch"><input id="opt-function-no-auto-load-image" v-model="preferences.sysConfig.opt_no_auto_load_image" type="checkbox"><div><div /></div></label></div>
      </section>
    </div>
    <div v-else class="opt-page" role="tabpanel">
      <form @submit.prevent="saveSettings"><section class="settings-section"><header>消息存储</header>
        <label class="field">记录保留天数<input v-model.number="form.retentionDays" type="number" min="1" max="3650" required></label>
        <label class="field">单文件上限 (MB)<input v-model.number="form.uploadMaxMB" type="number" min="1" max="100" required></label>
        <label class="field">媒体缓存上限 (MB)<input v-model.number="form.mediaCacheMB" type="number" min="20" max="102400" required></label>
        <button class="primary" :disabled="busy">保存设置</button>
      </section></form>
      <form @submit.prevent="changePassword"><section class="settings-section"><header>修改密码</header><label class="field">当前密码<input v-model="currentPassword" type="password" autocomplete="current-password" required></label><label class="field">新密码<input v-model="newPassword" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><button :disabled="busy">修改并重新登录</button></section></form>
    </div>
    <p v-if="error" role="alert" class="error-text">{{ error }}</p>
    <p class="attribution">Stapxs QQ Lite · Stapx Steve · AGPL-3.0<br>7a895b9 · Bot Web Panel</p>
  </dialog>
</template>
<script setup lang="ts">
import { reactive, ref } from 'vue'
import { usePreferences } from '../state/preferences'
import { usePanel } from '../state/panel'
const preferences = usePreferences(), panel = usePanel(), dialog = ref<HTMLDialogElement>(), tab = ref('view'), busy = ref(false), error = ref('')
const tabs = [{ id: 'view', name: '界面' }, { id: 'chat', name: '聊天' }, { id: 'account', name: '存储与账户' }]
const currentPassword = ref(''), newPassword = ref(''), form = reactive({ retentionDays: 7, uploadMaxMB: 20, mediaCacheMB: 512 })
function open() { Object.assign(form, panel.settings); error.value = ''; dialog.value?.showModal() }
async function saveSettings() {
  busy.value = true; error.value = ''
  try { panel.settings = await panel.request('settings', form); dialog.value?.close() } catch (e) { error.value = (e as Error).message } finally { busy.value = false }
}
async function changePassword() {
  busy.value = true; error.value = ''
  try { await panel.request('password', { current: currentPassword.value, password: newPassword.value }); currentPassword.value = ''; newPassword.value = ''; dialog.value?.close(); panel.authenticated = false } catch (e) { error.value = (e as Error).message } finally { busy.value = false }
}
defineExpose({ open })
</script>
