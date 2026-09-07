import type { Message, Segment } from '../types'

function segmentText(item: Segment): string {
  if (item.type === 'text' || item.type === 'markdown') return item.text || ''
  if (item.type === 'at') return `@${item.text || item.qq || ''}`
  if (item.type === 'forward') return (item.content || []).map(node => `${node.nickname}: ${node.message.map(segmentText).join('')}`).join('\n')
  return `[${({ image: '图片', file: '文件', face: '表情', video: '视频', record: '语音', reply: '回复' } as Record<string, string>)[item.type] || item.type}]`
}
export const messageText = (message: Message) => message.message.map(segmentText).join('')
export async function copyText(text: string) {
  try { if (navigator.clipboard) { await navigator.clipboard.writeText(text); return } } catch { /* Fall back on HTTP or a denied Clipboard API. */ }
  const focused = document.activeElement as HTMLElement | null, input = document.createElement('textarea')
  input.value = text; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); input.select()
  try { if (!document.execCommand('copy')) throw new Error('复制失败，请检查浏览器剪贴板权限') }
  finally { input.remove(); focused?.focus({ preventScroll: true }) }
}
