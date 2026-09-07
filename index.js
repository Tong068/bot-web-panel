import { createPanel } from './lib/server.js'
import { PanelCommand, stateKey } from './lib/commands.js'

if (globalThis[stateKey]) await globalThis[stateKey].close()
delete globalThis[stateKey]
try {
  globalThis[stateKey] = await createPanel(Bot)
  const port = Bot.server?.address?.()?.port
  logger.info(`[BotWeb] 消息面板已挂载：http://localhost:${port || 2536}/bot-web/`)
} catch (error) {
  logger.error(`[BotWeb] 加载失败：${error.message}`)
}

export const apps = { PanelCommand }
