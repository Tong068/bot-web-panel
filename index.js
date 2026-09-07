import { createPanel } from './lib/server.js'

const stateKey = Symbol.for('yunzai.bot-web-panel')
if (globalThis[stateKey]) await globalThis[stateKey].close()
try {
  globalThis[stateKey] = await createPanel(Bot)
  const port = Bot.server?.address?.()?.port
  logger.info(`[BotWeb] 消息面板已挂载：http://localhost:${port || 2536}/bot-web/`)
} catch (error) {
  logger.error(`[BotWeb] 加载失败：${error.message}`)
}

class PanelCommand extends plugin {
  constructor() { super({ name: '多机器人消息面板', event: 'message', rule: [{ reg: '^#消息面板$', fnc: 'address', permission: 'master' }] }) }
  async address() { return this.reply(`消息面板路径：/bot-web/\n使用框架现有端口。初始管理员密码见启动日志或插件 data/initial-password.txt。`) }
}
export const apps = { PanelCommand }
