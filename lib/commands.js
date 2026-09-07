import { panelAddresses } from './login-addresses.js'

export const stateKey = Symbol.for('yunzai.bot-web-panel')

export class PanelCommand extends plugin {
  constructor() {
    super({ name: '多机器人消息面板', event: 'message', rule: [
      { reg: '^#消息面板$', fnc: 'address', permission: 'master' },
      { reg: '^#?(?:消息面板|面板)(?:登录|登陆)$', fnc: 'login', permission: 'master' }
    ] })
  }
  async address() { return this.reply('消息面板路径：/bot-web/\n发送 #面板登录 获取临时登录链接，也可使用管理员账号密码登录。') }
  async login() {
    if (!this.e?.isMaster) return false
    const panel = globalThis[stateKey]
    if (!panel?.auth) return this.reply('消息面板未启用或加载失败，请检查插件配置和启动日志。')
    const addresses = await panelAddresses(Bot, panel.config)
    if (!Object.values(addresses).some(urls => urls.length)) return this.reply('无法获取消息面板地址，请检查框架 HTTP 服务或配置 publicUrl。')
    let code
    try { code = await panel.auth.createQuickLogin() }
    catch { return this.reply('生成登录链接失败，请检查插件状态后重试。') }
    const sections = [['custom', '自定义地址', '未配置'], ['local', '内网地址', '未获取到内网地址'], ['remote', '外网地址', '未获取到公网 IPv4 地址'], ['ipv6', 'IPv6 地址', '未获取到可用 IPv6 地址']]
    const messages = ['消息面板登录地址：', ...sections.map(([key, label, empty]) => `${label}：\n${addresses[key].length ? addresses[key].map(address => `${address}#login=${code}`).join('\n') : empty}`),
      `链接 3 分钟内有效，仅可使用一次，请勿转发。登录后会话有效期为 ${panel.config.sessionHours} 小时。`,
      'localhost 仅供机器人所在电脑使用；内网地址需在同一网络。外网和 IPv6 地址需对应端口可达；公网映射端口不同时请配置自定义地址。']
    const group = this.e.isGroup || this.e.message_type === 'group' || this.e.group_id != null
    try {
      let result
      const bot = this.e.bot || Bot.bots?.[this.e.self_id] || Bot[this.e.self_id]
      const recipient = this.e.friend || bot?.pickFriend?.(this.e.user_id) || bot?.pickUser?.(this.e.user_id)
      const nodes = messages.map(message => ({ user_id: this.e.self_id || bot?.uin, nickname: bot?.nickname || '消息面板', message }))
      // Build for the private recipient, including when the command came from a group.
      const maker = recipient?.makeForwardMsg ? recipient : bot?.makeForwardMsg ? bot : Bot
      const forward = await maker.makeForwardMsg(nodes)
      if (!forward) throw new Error('Forward message creation failed')
      if (group) {
        if (!recipient?.sendMsg) throw new Error('Private messaging unavailable')
        result = await recipient.sendMsg(forward)
      } else result = await this.reply(forward)
      if (result === false) throw new Error('Message delivery failed')
    } catch {
      await panel.auth.revokeQuickLogin(code).catch(() => {})
      return this.reply('登录地址发送失败，请添加当前机器人的好友后私聊发送 #面板登录。')
    }
    if (group) await this.reply('登录地址已发送至你的私信。')
    return true
  }
}
