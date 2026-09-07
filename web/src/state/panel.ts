import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import type { Bot, Capability, Contact, Draft, Message, Upload } from '../types'
import { requestId } from '../id'

const emptyCap = (): Capability => ({ text: false, image: false, at: false, quote: false, file: false, recall: false, members: false })
export const usePanel = defineStore('panel', () => {
  const authenticated = ref(false), starting = ref(true), csrf = ref(''), error = ref(''), connected = ref(false)
  const bots = ref<Bot[]>([]), activeBot = ref(''), contacts = reactive<Record<string, Contact[]>>({}), selected = reactive<Record<string, string>>({})
  const histories = reactive<Record<string, Message[]>>({}), drafts = reactive<Record<string, Draft>>({}), loading = ref(false), hasMore = ref(false), sending = reactive<Record<string, boolean>>({})
  const cap = ref(emptyCap()), settings = ref({ retentionDays: 7, uploadMaxMB: 20, mediaCacheMB: 512, sessionHours: 24 })
  const currentBot = computed(() => bots.value.find(x => x.id === activeBot.value))
  const current = computed(() => contacts[activeBot.value]?.find(x => x.key === selected[activeBot.value]))
  const messages = computed(() => histories[current.value?.key || ''] || [])
  const draft = computed(() => {
    const key = current.value?.key || ''
    return drafts[key] ||= { text: '', attachments: [], mentions: [], faces: [] }
  })
  let events: EventSource | undefined, controller: AbortController | undefined, generation = 0, refreshTimer: ReturnType<typeof setTimeout> | undefined
  let draftTimer: ReturnType<typeof setTimeout> | undefined
  const pendingHistories = new Map<number, { key: string; updates: Message[] }>()
  try { Object.assign(drafts, JSON.parse(localStorage.getItem('bot-web-drafts') || '{}')); Object.assign(selected, JSON.parse(localStorage.getItem('bot-web-selected') || '{}')) } catch { /* Ignore invalid browser cache. */ }
  watch(drafts, () => { clearTimeout(draftTimer); draftTimer = setTimeout(() => { try { localStorage.setItem('bot-web-drafts', JSON.stringify(drafts)) } catch { /* Storage may be unavailable. */ } }, 300) }, { deep: true })
  watch(selected, () => { try { localStorage.setItem('bot-web-selected', JSON.stringify(selected)) } catch {} }, { deep: true })
  async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`/bot-web/api/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.value }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal })
    const result = await response.json()
    if (!response.ok) {
      if (response.status === 401) { authenticated.value = false; events?.close(); connected.value = false }
      throw new Error(result.error || `请求失败 (${response.status})`)
    }
    return result
  }
  async function action<T>(action: string, params: unknown, bot_id = activeBot.value, signal?: AbortSignal) {
    const result = await request<{ data: T }>('action', { action, params, bot_id, echo: requestId() }, signal)
    return result.data
  }
  async function login(username: string, password: string) { const session = await request<{ csrf: string }>('login', { username, password }); csrf.value = session.csrf; authenticated.value = true; await ready() }
  async function init() {
    try { const session = await request<{ csrf: string }>('session'); csrf.value = session.csrf; authenticated.value = true; await ready() }
    catch (e) { if (authenticated.value) error.value = (e as Error).message }
    finally { starting.value = false }
  }
  async function ready() { settings.value = await request('settings'); await refreshBots(); if (activeBot.value) await switchBot(activeBot.value); stream() }
  async function refreshBots() {
    bots.value = await request('bots')
    if (!bots.value.some(b => b.id === activeBot.value)) activeBot.value = bots.value.find(b => b.online)?.id || bots.value[0]?.id || ''
  }
  const contactRequests = new Map<string, number>()
  async function refreshContacts(id = activeBot.value, signal?: AbortSignal) {
    if (!id) return
    const request = (contactRequests.get(id) || 0) + 1; contactRequests.set(id, request)
    const list = await action<Contact[]>('get_contacts', {}, id, signal)
    if (contactRequests.get(id) === request) contacts[id] = list
  }
  async function switchBot(id: string) {
    controller?.abort(); controller = new AbortController(); generation++; activeBot.value = id; cap.value = emptyCap(); loading.value = true
    const version = generation
    try { await refreshContacts(id, controller.signal); if (version !== generation) return; const contact = contacts[id]?.find(c => c.key === selected[id]); if (contact) await open(contact) }
    catch (e) { if ((e as Error).name !== 'AbortError' && version === generation) throw e }
    finally { if (version === generation) loading.value = false }
  }
  async function open(contact: Contact) {
    controller?.abort(); controller = new AbortController(); const version = ++generation
    const pending = { key: contact.key, updates: [] as Message[] }; pendingHistories.set(version, pending)
    activeBot.value = contact.bot_id; selected[contact.bot_id] = contact.key; loading.value = true; cap.value = emptyCap()
    try {
      const params = { kind: contact.kind, target_id: contact.target_id }
      const [list, capabilities] = await Promise.all([action<Message[]>('get_history', params, contact.bot_id, controller.signal), action<Capability>('get_capabilities', params, contact.bot_id, controller.signal)])
      if (version !== generation) return
      histories[contact.key] = list
      pendingHistories.delete(version)
      for (const message of pending.updates) upsert(message)
      hasMore.value = list.length === 50; cap.value = capabilities; await markRead()
    } catch (e) { if ((e as Error).name !== 'AbortError' && version === generation) error.value = (e as Error).message }
    finally { pendingHistories.delete(version); if (version === generation) loading.value = false }
  }
  async function older() {
    const contact = current.value; if (!contact || loading.value) return
    const version = generation; loading.value = true
    try {
      const list = await action<Message[]>('get_history', { kind: contact.kind, target_id: contact.target_id, before: messages.value[0]?.seq }, contact.bot_id, controller?.signal)
      if (version !== generation) return
      const map = new Map([...list, ...messages.value].map(x => [x.id, x])); histories[contact.key] = [...map.values()].sort((a, b) => a.seq - b.seq); hasMore.value = list.length === 50
    } catch (e) { if ((e as Error).name !== 'AbortError' && version === generation) throw e }
    finally { if (version === generation) loading.value = false }
  }
  async function markRead() {
    const contact = current.value, last = messages.value.at(-1)
    if (!contact || document.hidden) return
    await action('mark_read', { kind: contact.kind, target_id: contact.target_id, seq: last?.seq || contact.last_seq || 0 }, contact.bot_id)
    contact.unread = 0
  }
  async function setConversation(contact: Contact, changes: { pinned?: boolean; unread?: boolean }) {
    await action('set_conversation_preferences', { kind: contact.kind, target_id: contact.target_id, ...changes }, contact.bot_id)
    if (changes.unread && current.value?.key === contact.key) delete selected[contact.bot_id]
    await Promise.all([refreshContacts(contact.bot_id), refreshBots()])
  }
  function upsert(message: Message) {
    for (const pending of pendingHistories.values()) if (pending.key === message.conversation) pending.updates.push(message)
    const list = histories[message.conversation]
    if (list) { histories[message.conversation] = [...list.filter(m => m.id !== message.id && !message.replaced_ids?.includes(m.id) && !(message.platform_id && m.platform_id === message.platform_id)), message].sort((a, b) => a.seq - b.seq) }
  }
  function refreshSoon() {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { if (authenticated.value) Promise.all([refreshBots(), refreshContacts()]).catch(e => error.value = e.message) }, 150)
  }
  function stream() {
    events?.close(); events = new EventSource('/bot-web/api/events')
    let firstConnection = true
    events.onopen = () => {
      connected.value = true
      if (!firstConnection && current.value) open(current.value).catch(e => error.value = e.message)
      firstConnection = false; refreshSoon()
    }
    events.onerror = () => { connected.value = false; request('session').catch(() => {}) }
    events.onmessage = event => {
      const data = JSON.parse(event.data)
      if (data.type === 'message') { upsert(data.message); if (data.message.conversation === current.value?.key) markRead().catch(e => error.value = e.message) }
      if (data.type === 'reset' && current.value) open(current.value).catch(e => error.value = e.message)
      refreshSoon()
    }
  }
  async function upload(file: File, type: 'image' | 'file', contact = current.value) {
    if (!contact) return
    if (file.size > settings.value.uploadMaxMB * 1048576) throw new Error(`文件不能超过 ${settings.value.uploadMaxMB} MB`)
    const response = await fetch('/bot-web/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf.value, 'X-Bot-Id': contact.bot_id, 'X-File-Name': encodeURIComponent(file.name) }, body: file })
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '上传失败')
    ;(drafts[contact.key] ||= { text: '', attachments: [], mentions: [], faces: [] }).attachments.push({ ...result as Upload, type })
  }
  async function send() {
    const contact = current.value; if (!contact || sending[contact.key]) return
    const d = drafts[contact.key]; if (!d || !d.text.trim() && !d.attachments.length && !d.mentions.length && !d.faces.length) return
    const saved = JSON.stringify(d), request_id = requestId()
    const message = [...d.mentions.map(x => ({ type: 'at', qq: x.user_id, text: x.nickname })), ...d.faces.map(id => ({ type: 'face', id })), ...(d.text ? [{ type: 'text', text: d.text }] : []), ...d.attachments.map(x => ({ type: x.type, media_id: x.id }))]
    sending[contact.key] = true
    try {
      const result = await action<Message>(contact.kind === 'group' ? 'send_group_msg' : 'send_private_msg', { target_id: contact.target_id, message, request_id, quote_id: d.quote?.id }, contact.bot_id)
      upsert(result)
      if (['sent', 'unknown', 'partial'].includes(result.status)) { if (JSON.stringify(drafts[contact.key]) === saved) drafts[contact.key] = { text: '', attachments: [], mentions: [], faces: [] }; if (result.status !== 'sent') error.value = result.status === 'partial' ? '部分内容发送失败，请核对消息记录后补发' : '发送结果未确认，请核对消息记录' }
      else throw new Error(result.error || '发送失败，草稿已保留')
    } finally { sending[contact.key] = false }
  }
  async function recall(message: Message) { const result = await action<Message>('delete_msg', { id: message.id }, message.bot_id); upsert(result) }
  async function loadForward(message: Pick<Message, 'id' | 'bot_id'>, path: number[], signal?: AbortSignal) {
    const result = await action<Message>('get_forward_msg', { id: message.id, path }, message.bot_id, signal)
    upsert(result)
  }
  async function logout() { await request('logout', {}); events?.close(); authenticated.value = false; connected.value = false; csrf.value = ''; for (const key of Object.keys(histories)) delete histories[key] }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && authenticated.value) markRead().catch(() => {}) })
  return { authenticated, starting, error, connected, bots, activeBot, contacts, selected, currentBot, current, messages, draft, drafts, loading, hasMore, sending, cap, settings, init, login, logout, request, action, switchBot, open, older, markRead, upload, send, recall, loadForward, refreshContacts, setConversation }
})
