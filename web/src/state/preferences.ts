import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'

export type SendKey = 'none' | 'shift' | 'ctrl' | 'alt' | 'meta'
interface Preferences {
  opt_auto_dark: boolean
  opt_dark: boolean
  theme_color: number
  opt_ind_message: boolean
  opt_no_auto_load_image: boolean
  send_key: SendKey
  session_display_mode: 'recent' | 'all'
}
export const usePreferences = defineStore('preferences', () => {
  const sysConfig = reactive<Preferences>({ opt_auto_dark: true, opt_dark: false, theme_color: 0, opt_ind_message: true, opt_no_auto_load_image: false, send_key: 'none', session_display_mode: 'recent' })
  try {
    const old = localStorage.getItem('bot-web-theme')
    if (old) { sysConfig.opt_auto_dark = false; sysConfig.opt_dark = old === 'dark' }
    const saved = JSON.parse(localStorage.getItem('bot-web-preferences') || '{}')
    for (const key of ['opt_auto_dark', 'opt_dark', 'opt_ind_message', 'opt_no_auto_load_image'] as const) if (typeof saved[key] === 'boolean') sysConfig[key] = saved[key]
    if (Number.isInteger(saved.theme_color) && saved.theme_color >= 0 && saved.theme_color <= 5) sysConfig.theme_color = saved.theme_color
    if (['none', 'shift', 'ctrl', 'alt', 'meta'].includes(saved.send_key)) sysConfig.send_key = saved.send_key
    if (['recent', 'all'].includes(saved.session_display_mode)) sysConfig.session_display_mode = saved.session_display_mode
  } catch { /* Ignore invalid local preferences. */ }
  const query = matchMedia('(prefers-color-scheme: dark)'), systemDark = ref(query.matches)
  query.addEventListener('change', event => systemDark.value = event.matches)
  const dark = computed(() => sysConfig.opt_auto_dark ? systemDark.value : sysConfig.opt_dark)
  const colorNames = ['默认', '草绿', '樱粉', '淡紫', '金黄', '石墨']
  function applyColor() {
    const style = document.documentElement.style
    style.setProperty('--color-main', `var(--color-main-${sysConfig.theme_color})`)
    const value = getComputedStyle(document.documentElement).getPropertyValue(`--color-main-${sysConfig.theme_color}`).trim()
    if (/^#[0-9a-f]{6}$/i.test(value)) {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16))
      const foreground = r * .299 + g * .587 + b * .114 > 155 ? '#182126' : '#ffffff'
      style.setProperty('--color-font-r', foreground); style.setProperty('--color-font-1-r', foreground)
    }
  }
  watch(dark, value => {
    const link = document.querySelector<HTMLLinkElement>('#theme-colors')
    if (link) { link.onload = applyColor; link.href = `/bot-web/bcui/css/color-${value ? 'dark' : 'light'}.css` }
    document.documentElement.style.colorScheme = value ? 'dark' : 'light'
  }, { immediate: true })
  watch(() => sysConfig.theme_color, applyColor, { immediate: true })
  watch(sysConfig, value => { try { localStorage.setItem('bot-web-preferences', JSON.stringify(value)) } catch {} }, { deep: true })
  function toggleDark() { sysConfig.opt_dark = !dark.value; sysConfig.opt_auto_dark = false }
  function isSendKey(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return false
    const modifiers = { shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey }
    return Object.entries(modifiers).every(([key, pressed]) => pressed === (key === sysConfig.send_key))
  }
  return { sysConfig, dark, colorNames, toggleDark, isSendKey }
})
