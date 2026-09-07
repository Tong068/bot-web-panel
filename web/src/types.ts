export type Kind = 'group' | 'private'
export interface Segment { type: string; text?: string; qq?: string; id?: string; url?: string; media_id?: string; name?: string; unavailable?: boolean; content?: { nickname: string; message: Segment[] }[] }
export interface Message { id: string; seq: number; bot_id: string; conversation: string; kind: Kind; target_id: string; platform_id?: string; replaced_ids?: string[]; time: number; direction: 'in' | 'out'; origin: string; status: string; preview: string; recalled?: boolean; error?: string; sender: { user_id: string; nickname: string; role?: string; avatar?: string }; message: Segment[]; quote?: { id: string; text: string; user_id: string } }
export interface Contact { key: string; bot_id: string; kind: Kind; target_id: string; name: string; avatar: string; unread: number; pinned?: boolean; last?: Message; last_seq?: number }
export interface Bot { id: string; name: string; adapter: string; online: boolean; avatar: string; unread: number }
export interface Capability { text: boolean; image: boolean; at: boolean; quote: boolean; file: boolean; recall: boolean; members: boolean }
export interface Upload { id: string; name: string; size: number; mime: string; url: string }
export interface Draft { text: string; attachments: (Upload & { type: 'image' | 'file' })[]; mentions: { user_id: string; nickname: string }[]; faces: string[]; quote?: Message }
