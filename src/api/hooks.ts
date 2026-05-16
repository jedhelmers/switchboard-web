import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query'
import {
  api,
  APIError,
  type AttachmentFile,
  type Reaction,
  type Channel,
  type DMSummary,
  type Health,
  type Invite,
  type InviteWithToken,
  type Member,
  type Message,
  type OperatorAuditEntry,
  type OperatorChannel,
  type OperatorDM,
  type OperatorStats,
  type OperatorUser,
  type OperatorWorkspace,
  type PresignResponse,
  type User,
  type Workspace,
} from './client'

// ---- auth ------------------------------------------------------------------

export function useMe() {
  return useQuery<User | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<User>('/v1/me')
      } catch (err) {
        if (err instanceof APIError && err.status === 401) return null
        throw err
      }
    },
    retry: false,
    staleTime: 60_000,
  })
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { email: string; password: string }) =>
      api.post<User>('/v1/auth/login', vars),
    onSuccess: (user) => {
      qc.setQueryData(['me'], user)
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ status: string }>('/v1/auth/logout'),
    onSuccess: () => {
      qc.setQueryData(['me'], null)
      qc.clear()
    },
  })
}

// useUpdateMe patches the current user's profile. All fields optional —
// pass only what changed. avatar_object_key is the storage key returned by
// uploadAvatar; pass empty string to clear the avatar.
export type UpdateMeVars = {
  display_name?: string
  timezone?: string
  locale?: string
  avatar_object_key?: string
}

export function useUpdateMe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: UpdateMeVars) => api.patch<User>('/v1/me', vars),
    onSuccess: (user) => {
      qc.setQueryData(['me'], user)
      // Members lists across every workspace embed the same display_name and
      // avatar — refetch so the chat sidebar + message rows update.
      qc.invalidateQueries({ queryKey: ['members'] })
    },
  })
}

// uploadAvatar runs presign → PUT and resolves to the storage object_key the
// caller should send back via useUpdateMe. Two phases on purpose: we don't
// commit the avatar to the user row until the bytes are confirmed in S3.
export async function uploadAvatar(file: File): Promise<string> {
  const presigned = await api.post<{ upload_url: string; object_key: string }>(
    '/v1/me/avatar/presign',
    {
      filename: file.name,
      content_type: file.type || 'application/octet-stream',
      bytes: file.size,
    },
  )
  await putWithProgress(presigned.upload_url, file)
  return presigned.object_key
}

// ---- workspaces / channels --------------------------------------------------

export function useMyWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<{ workspaces: Workspace[] }>('/v1/workspaces').then((r) => r.workspaces),
  })
}

export function useChannels(slug: string | null) {
  return useQuery({
    queryKey: ['channels', slug],
    queryFn: () =>
      api
        .get<{ channels: Channel[] }>(`/v1/workspaces/${slug}/channels`)
        .then((r) => r.channels),
    enabled: !!slug,
  })
}

export function useMembers(slug: string | null) {
  return useQuery({
    queryKey: ['members', slug],
    queryFn: () =>
      api.get<{ members: Member[] }>(`/v1/workspaces/${slug}/members`).then((r) => r.members),
    enabled: !!slug,
    staleTime: 30_000,
  })
}

// ---- unread state ----------------------------------------------------------

// Server returns { unread: { channelId: count, ... } } for every channel the
// caller belongs to in the workspace, including zero-counts so the client
// doesn't need a follow-up to render the badge.
export type UnreadMap = Record<string, number>

export function useUnreadCounts(slug: string | null) {
  return useQuery<UnreadMap>({
    queryKey: ['unread', slug],
    queryFn: () =>
      api.get<{ unread: UnreadMap }>(`/v1/workspaces/${slug}/unread`).then((r) => r.unread),
    enabled: !!slug,
    staleTime: 5_000,
  })
}

// useMarkChannelRead is a fire-and-forget POST plus an optimistic local zero
// so the badge clears the instant the user activates the channel. Server is
// the source of truth — its SQL guard only moves last_read_at forward, so
// racing clients can't accidentally re-mark unread.
export function useMarkChannelRead(slug: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (channelId: string) =>
      api.post<void>(`/v1/channels/${channelId}/read`),
    onMutate: (channelId) => {
      if (!slug) return
      qc.setQueryData<UnreadMap>(['unread', slug], (prev) => {
        if (!prev) return prev
        if (!(channelId in prev) || prev[channelId] === 0) return prev
        return { ...prev, [channelId]: 0 }
      })
    },
  })
}

// bumpUnread increments the cached unread count for one channel in every
// workspace cache (we don't know which workspace the channel belongs to from
// the realtime event alone). Called by the realtime patcher on new messages
// the local user is not the author of and is not currently viewing.
function bumpUnread(qc: QueryClient, channelId: string) {
  qc.getQueriesData<UnreadMap>({ queryKey: ['unread'], exact: false }).forEach(
    ([key, prev]) => {
      if (!prev) return
      if (!(channelId in prev)) return
      qc.setQueryData<UnreadMap>(key, { ...prev, [channelId]: prev[channelId]! + 1 })
    },
  )
}

// Active channel signal — components write the currently-viewed channel id so
// the realtime patcher knows not to bump unread for it. A bare module ref is
// fine: there's only one chat surface at a time and React owns the lifecycle.
const activeChannelRef: { current: string | null } = { current: null }

export function setActiveChannel(channelId: string | null) {
  activeChannelRef.current = channelId
}

// Local user id, set by the Chat shell so the realtime patcher can skip
// bumping unread on the user's own messages.
const currentUserRef: { current: string | null } = { current: null }

export function setCurrentUser(userId: string | null) {
  currentUserRef.current = userId
}

// ---- messages --------------------------------------------------------------

// ---- realtime: shared client + cache integration --------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import { RealtimeClient, realtimeURL, type ConnectionState, type RealtimeEvent } from './realtime'
import type { QueryClient } from '@tanstack/react-query'

let sharedClient: RealtimeClient | null = null

// Infinite query page shape — matches /v1/channels/{id}/messages response.
export type MessagesPage = { messages: Message[]; next_cursor?: string }

export type MessagesInfiniteData = InfiniteData<MessagesPage, string | undefined>

function applyRealtimeEvent(qc: QueryClient, ev: RealtimeEvent) {
  // useMessages keys queries by ['messages', channelId, anchorId ?? ''] so
  // changing the anchor (e.g. from a search-result jump) gets a fresh fetch.
  // Realtime patches need to update EVERY cached variant for the channel —
  // both the no-anchor "live" view and any anchor-scoped views the user
  // happens to have visited. setQueriesData with a prefix-only key + exact:false
  // matches all of them.
  const filter = { queryKey: ['messages', ev.channel_id], exact: false } as const
  switch (ev.type) {
    case 'message.created': {
      const rootId = ev.payload.thread_root_id
      if (rootId) {
        // Thread reply — never goes into the channel timeline. Append to
        // the thread cache if it's loaded (don't create one from a single
        // reply — we'd be storing a partial page). The parent's reply_count
        // is updated via bumpReplyCount, which is id-deduped against the
        // local mutation's onSuccess so the sender never double-counts.
        qc.setQueryData<ThreadPage>(['thread', rootId], (prev) => {
          if (!prev) return prev
          if (prev.replies.some((m) => m.id === ev.message_id)) return prev
          return {
            replies: [...prev.replies, ev.payload],
            reply_count: prev.reply_count + 1,
          }
        })
        bumpReplyCount(qc, ev.channel_id, rootId, ev.message_id, ev.payload.created_at)
        break
      }
      qc.setQueriesData<MessagesInfiniteData>(filter, (prev) => {
        if (!prev || prev.pages.length === 0) return prev
        // De-dup across all pages (the poster gets the optimistic POST result first).
        if (prev.pages.some((p) => p.messages.some((m) => m.id === ev.message_id))) {
          return prev
        }
        // New message lands on the first page (newest first).
        const first = prev.pages[0]!
        const rest = prev.pages.slice(1)
        return {
          ...prev,
          pages: [{ ...first, messages: [ev.payload, ...first.messages] }, ...rest],
        }
      })
      // Refresh DM lists across all workspaces — a previously-empty DM may
      // now have its first message and need to appear in the recipient's
      // sidebar. Cheap: only active queries refetch.
      qc.invalidateQueries({ queryKey: ['dms'] })

      // Bump the unread badge if this message lands in a channel the user
      // isn't currently viewing AND wasn't sent by them. The active channel
      // ref + current user ref are written by the Chat shell.
      const authoredByMe =
        currentUserRef.current != null &&
        ev.payload.user_id === currentUserRef.current
      if (!authoredByMe && activeChannelRef.current !== ev.channel_id) {
        bumpUnread(qc, ev.channel_id)
      }
      break
    }
    case 'message.updated': {
      // Merge rather than replace. The server's edit handler doesn't
      // populate reply_count / last_reply_at on the broadcast payload (those
      // come from a separate bulk loader), so a hard replace would wipe
      // those fields from the cache and the thread badge would vanish on
      // every edit. Spread-merge preserves everything the new payload
      // doesn't carry.
      qc.setQueriesData<MessagesInfiniteData>(filter, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          pages: prev.pages.map((p) => ({
            ...p,
            messages: p.messages.map((m) =>
              m.id === ev.message_id ? { ...m, ...ev.payload } : m,
            ),
          })),
        }
      })
      // Edits to a reply also need to flow into the open thread cache.
      const updRoot = ev.payload.thread_root_id
      if (updRoot) {
        qc.setQueryData<ThreadPage>(['thread', updRoot], (prev) => {
          if (!prev) return prev
          return {
            ...prev,
            replies: prev.replies.map((m) =>
              m.id === ev.message_id ? { ...m, ...ev.payload } : m,
            ),
          }
        })
      }
      break
    }
    case 'message.deleted': {
      qc.setQueriesData<MessagesInfiniteData>(filter, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          pages: prev.pages.map((p) => ({
            ...p,
            messages: p.messages.filter((m) => m.id !== ev.message_id),
          })),
        }
      })
      // If the deleted message was a thread reply, prune it from the open
      // thread + decrement the parent's reply_count. We don't know rootId
      // from the event itself, so walk every cached thread.
      qc.getQueriesData<ThreadPage>({ queryKey: ['thread'], exact: false }).forEach(
        ([key, prev]) => {
          if (!prev) return
          const found = prev.replies.find((m) => m.id === ev.message_id)
          if (!found) return
          qc.setQueryData<ThreadPage>(key, {
            replies: prev.replies.filter((m) => m.id !== ev.message_id),
            reply_count: Math.max(0, prev.reply_count - 1),
          })
          const rootId = key[1] as string | undefined
          if (rootId) {
            patchMessage(qc, ev.channel_id, rootId, (m) => ({
              ...m,
              reply_count: Math.max(0, (m.reply_count ?? 1) - 1),
            }))
          }
        },
      )
      break
    }
  }
}

// useRealtime maintains a single WS connection for the lifetime of the auth'd
// session. Exposes the connection state so consumers (eg. useMessages) can
// disable polling when push is live.
export function useRealtime(): ConnectionState {
  const qc = useQueryClient()
  const [state, setState] = useState<ConnectionState>('closed')

  useEffect(() => {
    if (!sharedClient) {
      sharedClient = new RealtimeClient(realtimeURL())
    }
    const c = sharedClient
    const offState = c.onState(setState)
    const offEvent = c.on((ev) => applyRealtimeEvent(qc, ev))
    c.start()
    return () => {
      offState()
      offEvent()
      // Note: we don't stop the client on unmount; it lives across remounts.
    }
  }, [qc])

  return state
}

// useMessages: cursor-paginated infinite query over a channel's messages.
// Pages are returned newest-first; fetchNextPage loads OLDER messages
// (the API cursor walks backward in time). Realtime push updates the first page
// in place; falls back to polling the first page when the WS is closed.
//
// anchorId (optional): when set, the FIRST page is fetched with ?anchor=<id>
// returning a window centered on that message. Used by "scroll to message"
// from search results. After the anchor fetch, fetchNextPage walks normally
// backward from the oldest message in the window. Anchor is part of the
// query key so changing it forces a fresh first fetch.
export function useMessages(
  channelId: string | null,
  realtimeOpen: boolean = false,
  anchorId: string | null = null,
) {
  return useInfiniteQuery<MessagesPage, Error, MessagesInfiniteData, readonly unknown[], string | undefined>({
    queryKey: ['messages', channelId, anchorId ?? ''],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      if (pageParam) params.set('cursor', pageParam)
      else if (anchorId) params.set('anchor', anchorId)
      const qs = params.toString()
      return api.get<MessagesPage>(`/v1/channels/${channelId}/messages${qs ? `?${qs}` : ''}`)
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: !!channelId,
    refetchInterval: realtimeOpen ? false : 2000,
    refetchIntervalInBackground: false,
  })
}

export function usePostMessage(channelId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { text: string; payload?: unknown; file_ids?: string[] }) =>
      api.post<Message>(`/v1/channels/${channelId}/messages`, vars),
    onSuccess: (msg) => {
      // Optimistic insert into page 0 so the message shows immediately, even
      // before the WS event lands. Realtime patcher de-dups by id, and we avoid
      // invalidate so older pages (loaded by scroll) don't refetch and yank
      // the viewport.
      qc.setQueriesData<MessagesInfiniteData>(
        { queryKey: ['messages', channelId], exact: false },
        (prev) => {
          if (!prev || prev.pages.length === 0) return prev
          if (prev.pages.some((p) => p.messages.some((m) => m.id === msg.id))) {
            return prev
          }
          const first = prev.pages[0]!
          const rest = prev.pages.slice(1)
          return {
            ...prev,
            pages: [{ ...first, messages: [msg, ...first.messages] }, ...rest],
          }
        },
      )
    },
  })
}

// ---- message edit / delete / reactions -------------------------------------

// Helper: patch one message in every cached variant for a channel (live view
// + any anchor-scoped views, since useMessages keys queries by anchorId too).
function patchMessage(
  qc: QueryClient,
  channelId: string,
  messageId: string,
  fn: (m: Message) => Message,
) {
  qc.setQueriesData<MessagesInfiniteData>(
    { queryKey: ['messages', channelId], exact: false },
    (prev) => {
      if (!prev) return prev
      return {
        ...prev,
        pages: prev.pages.map((p) => ({
          ...p,
          messages: p.messages.map((m) => (m.id === messageId ? fn(m) : m)),
        })),
      }
    },
  )
}

// Helper: drop one message from every cached variant for a channel.
function dropMessage(qc: QueryClient, channelId: string, messageId: string) {
  qc.setQueriesData<MessagesInfiniteData>(
    { queryKey: ['messages', channelId], exact: false },
    (prev) => {
      if (!prev) return prev
      return {
        ...prev,
        pages: prev.pages.map((p) => ({
          ...p,
          messages: p.messages.filter((m) => m.id !== messageId),
        })),
      }
    },
  )
}

export function useEditMessage(channelId: string | null) {
  return useMutation({
    mutationFn: (vars: { messageId: string; text: string; payload?: unknown }) =>
      api.patch<Message>(`/v1/messages/${vars.messageId}`, {
        text: vars.text,
        payload: vars.payload,
      }),
    // No optimistic update: server returns the canonical edited message and
    // realtime patcher will push it to other clients. We refresh ours via
    // the mutation result here.
  })
}

export function useDeleteMessage(channelId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (messageId: string) => api.del(`/v1/messages/${messageId}`),
    onMutate: (messageId) => {
      if (!channelId) return
      // Optimistic drop. Realtime message.deleted will arrive shortly and
      // de-dups via the same filter.
      dropMessage(qc, channelId, messageId)
    },
  })
}

export function useToggleReaction(channelId: string | null, currentUserID: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { messageId: string; emoji: string; alreadyReacted: boolean }) => {
      if (vars.alreadyReacted) {
        await api.del(`/v1/messages/${vars.messageId}/reactions/${encodeURIComponent(vars.emoji)}`)
      } else {
        await api.post(`/v1/messages/${vars.messageId}/reactions`, { emoji: vars.emoji })
      }
    },
    onMutate: ({ messageId, emoji, alreadyReacted }) => {
      if (!channelId) return
      // Optimistically toggle the reaction in cache so the UI snaps without
      // waiting for server + realtime round-trip.
      patchMessage(qc, channelId, messageId, (m) => {
        const next = (m.reactions ?? []).slice()
        const idx = next.findIndex((r) => r.emoji === emoji)
        if (alreadyReacted) {
          if (idx === -1) return m
          const r = next[idx]!
          const users = r.user_ids.filter((u) => u !== currentUserID)
          if (users.length === 0) next.splice(idx, 1)
          else next[idx] = { ...r, count: users.length, user_ids: users }
        } else {
          if (idx === -1) {
            next.push({ emoji, count: 1, user_ids: [currentUserID] })
          } else {
            const r = next[idx]!
            if (r.user_ids.includes(currentUserID)) return m
            next[idx] = { ...r, count: r.count + 1, user_ids: [...r.user_ids, currentUserID] }
          }
        }
        return { ...m, reactions: next }
      })
    },
  })
}

// keep Reaction in scope to satisfy unused-import lint when this file is
// referenced for types only.
export type { Reaction }

// ---- threads ---------------------------------------------------------------

export type ThreadPage = { replies: Message[]; reply_count: number }

// useThreadReplies fetches all replies for a thread root. Slack-style threads
// are 1-deep so a flat list is the whole conversation. We use a plain useQuery
// (not infinite) because thread depths are bounded in practice.
export function useThreadReplies(rootId: string | null) {
  return useQuery<ThreadPage>({
    queryKey: ['thread', rootId],
    enabled: !!rootId,
    queryFn: () => api.get<ThreadPage>(`/v1/messages/${rootId}/replies`),
  })
}

// usePostThreadReply posts to a thread and patches both the thread cache and
// the parent message's reply_count in the channel timeline. The realtime
// patcher applies the same logic when other clients send replies.
export function usePostThreadReply(rootId: string | null, channelId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { text: string; payload?: unknown; file_ids?: string[] }) =>
      api.post<Message>(`/v1/messages/${rootId}/replies`, vars),
    onSuccess: (reply) => {
      if (rootId) {
        qc.setQueryData<ThreadPage>(['thread', rootId], (prev) => {
          if (!prev) return { replies: [reply], reply_count: 1 }
          // De-dup in case realtime got here first.
          if (prev.replies.some((m) => m.id === reply.id)) return prev
          return { replies: [...prev.replies, reply], reply_count: prev.reply_count + 1 }
        })
      }
      if (channelId && rootId) {
        bumpReplyCount(qc, channelId, rootId, reply.id, reply.created_at)
      }
    },
  })
}

// bumpedReplyIds dedups parent reply_count increments by reply id. Both the
// local mutation (usePostThreadReply.onSuccess) and the realtime patcher try
// to bump for the same reply — without dedup the sender would double-count
// because the server publishes the realtime event before the HTTP response
// returns, so the two paths can race in either order. The id-based check
// here is order-independent: whichever fires first applies the +1, the
// second is a no-op. FIFO-evicts after 5000 entries so memory stays bounded.
const bumpedReplyIds = new Set<string>()
const bumpedReplyOrder: string[] = []
const BUMP_DEDUP_CAP = 5000

function rememberBump(replyId: string): boolean {
  if (bumpedReplyIds.has(replyId)) return false
  bumpedReplyIds.add(replyId)
  bumpedReplyOrder.push(replyId)
  if (bumpedReplyOrder.length > BUMP_DEDUP_CAP) {
    const evict = bumpedReplyOrder.shift()
    if (evict) bumpedReplyIds.delete(evict)
  }
  return true
}

// bumpReplyCount adds 1 to the parent's reply_count and updates last_reply_at
// in every cached variant of the channel's messages list. Idempotent per
// replyId — call from both usePostThreadReply and applyRealtimeEvent.
function bumpReplyCount(
  qc: QueryClient,
  channelId: string,
  rootId: string,
  replyId: string,
  lastReplyAt: string,
) {
  if (!rememberBump(replyId)) return
  patchMessage(qc, channelId, rootId, (m) => ({
    ...m,
    reply_count: (m.reply_count ?? 0) + 1,
    last_reply_at: lastReplyAt,
  }))
}

// ---- channels: create / browse / join --------------------------------------

export function useCreateChannel(slug: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: {
      slug: string
      name?: string
      kind?: 'public' | 'private'
      topic?: string
      description?: string
    }) => api.post<Channel>(`/v1/workspaces/${slug}/channels`, vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels', slug] })
    },
  })
}

export function usePublicChannels(slug: string | null) {
  return useQuery({
    queryKey: ['public-channels', slug],
    queryFn: () =>
      api
        .get<{ channels: Channel[] }>(`/v1/workspaces/${slug}/channels/public`)
        .then((r) => r.channels),
    enabled: !!slug,
    staleTime: 5_000,
  })
}

export function useJoinChannel(slug: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (channelId: string) => api.post<Channel>(`/v1/channels/${channelId}/join`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels', slug] })
      qc.invalidateQueries({ queryKey: ['public-channels', slug] })
    },
  })
}

// ---- search ----------------------------------------------------------------

// useSearchMessages runs full-text search against the workspace, optionally
// scoped to a single channel. Empty queries short-circuit to no request.
// Debouncing happens in the consumer via debouncing the `q` value passed in.
export function useSearchMessages(
  slug: string | null,
  q: string,
  channelId: string | null,
) {
  return useQuery({
    queryKey: ['search', slug, q, channelId ?? ''],
    queryFn: () => {
      const params = new URLSearchParams()
      params.set('q', q)
      if (channelId) params.set('channel_id', channelId)
      return api
        .get<{ messages: Message[] }>(`/v1/workspaces/${slug}/search?${params.toString()}`)
        .then((r) => r.messages)
    },
    enabled: !!slug && q.trim().length > 0,
    staleTime: 5_000,
  })
}

// ---- DMs -------------------------------------------------------------------

export function useDMs(slug: string | null) {
  return useQuery({
    queryKey: ['dms', slug],
    queryFn: () =>
      api.get<{ dms: DMSummary[] }>(`/v1/workspaces/${slug}/dms`).then((r) => r.dms),
    enabled: !!slug,
  })
}

// useStartDM is find-or-create. Returns the channel; the server returns the
// same channel for repeat calls with the same target user_id.
export function useStartDM(slug: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userID: string) =>
      api.post<Channel>(`/v1/workspaces/${slug}/dms`, { user_id: userID }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dms', slug] })
    },
  })
}

// ---- typing indicators ----------------------------------------------------

// TYPING_TTL_MS: how long a typing entry stays live without a refresh event.
// Slightly longer than the client's notify cadence (3s) so a single dropped
// realtime packet doesn't blink the indicator off.
const TYPING_TTL_MS = 5000

// useTypingState subscribes to the shared realtime client and returns the set
// of *other* users currently typing in the given channel. The set re-renders
// when entries change and when their TTLs expire.
export function useTypingState(channelId: string | null, currentUserID: string): string[] {
  const [version, setVersion] = useState(0)
  // Map<channel_id, Map<user_id, expires_at_ms>> kept in a ref so we don't
  // re-render the world on every keystroke event.
  const stateRef = useRef<Map<string, Map<string, number>>>(new Map())

  useEffect(() => {
    if (!sharedClient) {
      sharedClient = new RealtimeClient(realtimeURL())
    }
    const c = sharedClient

    const off = c.on((ev) => {
      if (ev.type !== 'typing.started' && ev.type !== 'typing.stopped') return
      if (ev.user_id === currentUserID) return // never show ourselves
      const channelMap =
        stateRef.current.get(ev.channel_id) ??
        (stateRef.current.set(ev.channel_id, new Map()).get(ev.channel_id) as Map<string, number>)
      if (ev.type === 'typing.started') {
        channelMap.set(ev.user_id, Date.now() + TYPING_TTL_MS)
      } else {
        channelMap.delete(ev.user_id)
      }
      setVersion((v) => v + 1)
    })

    // Sweep expired entries every 1s.
    const sweep = window.setInterval(() => {
      const now = Date.now()
      let changed = false
      stateRef.current.forEach((channelMap) => {
        channelMap.forEach((expiresAt, userId) => {
          if (expiresAt <= now) {
            channelMap.delete(userId)
            changed = true
          }
        })
      })
      if (changed) setVersion((v) => v + 1)
    }, 1000)

    c.start()
    return () => {
      off()
      window.clearInterval(sweep)
    }
  }, [currentUserID])

  if (!channelId) {
    void version // keep the lint happy
    return []
  }
  const channelMap = stateRef.current.get(channelId)
  if (!channelMap || channelMap.size === 0) {
    void version
    return []
  }
  // Snapshot live (non-expired) user ids.
  const now = Date.now()
  const out: string[] = []
  channelMap.forEach((expiresAt, userId) => {
    if (expiresAt > now) out.push(userId)
  })
  return out
}

// TYPING_NOTIFY_INTERVAL_MS: cadence for re-sending typing.started while the
// user is actively typing. Keep below TYPING_TTL_MS or the indicator will
// blink off mid-typing. 3s is the conventional balance.
const TYPING_NOTIFY_INTERVAL_MS = 3000

// useTypingNotifier returns two functions for the composer:
//   notify() — call on every keystroke. Throttles to one POST per 3s.
//   stop()   — call on send / blur / unmount to snap the indicator off
//              for receivers without waiting for their TTL to expire.
// No-op when channelId is null (eg. between channels).
export function useTypingNotifier(channelId: string | null) {
  const lastSentRef = useRef(0)
  const isTypingRef = useRef(false)

  const stop = useCallback(() => {
    if (!channelId || !isTypingRef.current) return
    isTypingRef.current = false
    lastSentRef.current = 0
    // Best-effort: don't await, don't surface errors. The receiver's TTL is
    // the safety net.
    void api.del(`/v1/channels/${channelId}/typing`).catch(() => {})
  }, [channelId])

  const notify = useCallback(() => {
    if (!channelId) return
    const now = Date.now()
    if (now - lastSentRef.current < TYPING_NOTIFY_INTERVAL_MS) return
    lastSentRef.current = now
    isTypingRef.current = true
    void api.post(`/v1/channels/${channelId}/typing`).catch(() => {})
  }, [channelId])

  // If the channel changes mid-flight, send a stop for the previous one.
  useEffect(() => {
    return () => {
      stop()
    }
  }, [stop])

  return { notify, stop }
}

// useArchiveChannel hides a channel for everyone in the workspace.
// Workspace-admin gated server-side; the UI also gates the affordance.
export function useArchiveChannel(slug: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (channelId: string) =>
      api.post(`/v1/channels/${channelId}/archive`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels', slug] })
      qc.invalidateQueries({ queryKey: ['public-channels', slug] })
    },
  })
}

// useDeleteChannel soft-deletes a channel (sets deleted_at). Permanent from
// the UI's perspective; row stays in the DB for audit / future hard-purge.
export function useDeleteChannel(slug: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (channelId: string) => api.del(`/v1/channels/${channelId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels', slug] })
      qc.invalidateQueries({ queryKey: ['public-channels', slug] })
    },
  })
}

// useLeaveChannel soft-removes the caller from a channel by setting
// channel_memberships.left_at. For DMs this is the "delete chat" action —
// the conversation reopens for the caller automatically if the other
// participant posts a new message. For named channels it's "leave channel."
export function useLeaveChannel(slug: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (channelId: string) =>
      api.post(`/v1/channels/${channelId}/leave`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels', slug] })
      qc.invalidateQueries({ queryKey: ['dms', slug] })
    },
  })
}

// ---- attachments ----------------------------------------------------------

// uploadAttachment runs the full presign → PUT → finalize dance for a single
// file. Returns the finalized file metadata (incl. id, ready for attaching to
// a message). onProgress fires 0..1 during the PUT phase.
export async function uploadAttachment(
  workspaceSlug: string,
  file: File,
  onProgress?: (frac: number) => void,
): Promise<AttachmentFile> {
  // 1. Reserve a row + get a presigned PUT URL.
  const presigned = await api.post<PresignResponse>(
    `/v1/workspaces/${workspaceSlug}/uploads/presign`,
    {
      filename: file.name,
      content_type: file.type || 'application/octet-stream',
      bytes: file.size,
    },
  )

  // 2. PUT directly to MinIO/S3. We use XHR for progress events; fetch can't.
  await putWithProgress(presigned.upload_url, file, onProgress)

  // 3. Tell the server to mark the row ready. Pass image dimensions if known.
  let imageWidth: number | undefined
  let imageHeight: number | undefined
  if (file.type.startsWith('image/')) {
    try {
      const dim = await readImageDimensions(file)
      imageWidth = dim.width
      imageHeight = dim.height
    } catch {
      // Non-fatal — server still finalizes without dims.
    }
  }
  return api.post<AttachmentFile>(`/v1/files/${presigned.file_id}/finalize`, {
    image_width: imageWidth,
    image_height: imageHeight,
  })
}

function putWithProgress(
  url: string,
  file: File,
  onProgress?: (frac: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) {
        onProgress(e.loaded / e.total)
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`PUT failed: ${xhr.status} ${xhr.statusText}`))
    }
    xhr.onerror = () => reject(new Error('PUT network error'))
    xhr.send(file)
  })
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      URL.revokeObjectURL(url)
      resolve({ width: w, height: h })
    }
    img.onerror = (e) => {
      URL.revokeObjectURL(url)
      reject(e)
    }
    img.src = url
  })
}

// ---- workspace invites (admin/owner only) ----------------------------------

export function useWorkspaceInvites(slug: string | null) {
  return useQuery({
    queryKey: ['invites', slug],
    queryFn: () =>
      api
        .get<{ invites: Invite[] }>(`/v1/workspaces/${slug}/invites`)
        .then((r) => r.invites),
    enabled: !!slug,
  })
}

export function useCreateWorkspaceInvite(slug: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: {
      role?: 'admin' | 'member' | 'guest'
      email?: string
      max_uses?: number
      expires_in?: string
    }) => api.post<InviteWithToken>(`/v1/workspaces/${slug}/invites`, vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invites', slug] })
    },
  })
}

export function useRevokeWorkspaceInvite(slug: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/workspaces/${slug}/invites/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invites', slug] })
    },
  })
}

// ---- invite acceptance (no auth — public route) ---------------------------

export function useAcceptInvite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: {
      token: string
      email: string
      password: string
      display_name: string
      timezone?: string
      locale?: string
    }) => api.post<User>('/v1/invites/accept', vars),
    onSuccess: (user) => {
      qc.setQueryData(['me'], user)
    },
  })
}

// ---- operator dashboard ----------------------------------------------------

export function useOperatorStats() {
  return useQuery({
    queryKey: ['op', 'stats'],
    queryFn: () => api.get<OperatorStats>('/v1/operator/stats'),
    refetchInterval: 5_000,
  })
}

export function useOperatorWorkspaces(q: string) {
  return useQuery({
    queryKey: ['op', 'workspaces', q],
    queryFn: () =>
      api
        .get<{ workspaces: OperatorWorkspace[] }>(
          `/v1/operator/workspaces?q=${encodeURIComponent(q)}`,
        )
        .then((r) => r.workspaces),
    staleTime: 2_000,
  })
}

export function useOperatorChannels(q: string, kind: '' | 'public' | 'private') {
  return useQuery({
    queryKey: ['op', 'channels', q, kind],
    queryFn: () =>
      api
        .get<{ channels: OperatorChannel[] }>(
          `/v1/operator/channels?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(kind)}`,
        )
        .then((r) => r.channels),
    staleTime: 2_000,
  })
}

export function useOperatorDMs(q: string) {
  return useQuery({
    queryKey: ['op', 'dms', q],
    queryFn: () =>
      api
        .get<{ dms: OperatorDM[] }>(`/v1/operator/dms?q=${encodeURIComponent(q)}`)
        .then((r) => r.dms),
    staleTime: 2_000,
  })
}

export function useOperatorUsers(q: string) {
  return useQuery({
    queryKey: ['op', 'users', q],
    queryFn: () =>
      api
        .get<{ users: OperatorUser[] }>(`/v1/operator/users?q=${encodeURIComponent(q)}`)
        .then((r) => r.users),
    staleTime: 2_000,
  })
}

export function useOperatorAudit(action: string, actorID: string) {
  return useQuery({
    queryKey: ['op', 'audit', action, actorID],
    queryFn: () => {
      const params = new URLSearchParams()
      if (action) params.set('action', action)
      if (actorID) params.set('actor_id', actorID)
      const qs = params.toString()
      return api
        .get<{ entries: OperatorAuditEntry[] }>(
          '/v1/operator/audit' + (qs ? `?${qs}` : ''),
        )
        .then((r) => r.entries)
    },
    staleTime: 2_000,
  })
}

// ---- operator mutations ---------------------------------------------------

function invalidateOperator(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['op'] })
}

export function useOpCreateWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: {
      slug: string
      name: string
      owner_user_id: string
      description?: string
      invite_policy?: string
    }) => api.post<{ id: string; slug: string; name: string }>('/v1/operator/workspaces', vars),
    onSuccess: () => invalidateOperator(qc),
  })
}

export function useOpSuspendWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/v1/operator/workspaces/${id}/suspend`),
    onSuccess: () => invalidateOperator(qc),
  })
}

export function useOpUnsuspendWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/v1/operator/workspaces/${id}/unsuspend`),
    onSuccess: () => invalidateOperator(qc),
  })
}

export function useOpDeleteWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/operator/workspaces/${id}`),
    onSuccess: () => invalidateOperator(qc),
  })
}

export function useOpCreateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: {
      email: string
      display_name: string
      password: string
      is_operator?: boolean
    }) => api.post<{ id: string; email: string }>('/v1/operator/users', vars),
    onSuccess: () => invalidateOperator(qc),
  })
}

export function useOpLockUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/v1/operator/users/${id}/lock`),
    onSuccess: () => invalidateOperator(qc),
  })
}

export function useOpUnlockUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/v1/operator/users/${id}/unlock`),
    onSuccess: () => invalidateOperator(qc),
  })
}

export function useOpForceLogoutUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ revoked: number }>(`/v1/operator/users/${id}/force-logout`),
    onSuccess: () => invalidateOperator(qc),
  })
}

export function useOpDeleteUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/operator/users/${id}`),
    onSuccess: () => invalidateOperator(qc),
  })
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      // /readyz can return 503; treat that as data, not error.
      const res = await fetch('/api/readyz', { credentials: 'include' })
      const body = (await res.json()) as Health
      return { ok: res.ok, checks: body }
    },
    refetchInterval: 5_000,
  })
}
