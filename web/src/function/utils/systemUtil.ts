export function formatSessionTime(value?: number) {
  if (!value) return ''
  const date = new Date(value * 1000), today = new Date()
  return date.toDateString() === today.toDateString() ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}
