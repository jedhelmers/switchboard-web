import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Editor } from '@tiptap/react'
import { EditorView, MessageRender, docIsEmpty, useChatEditor } from './RichEditor'
import { extractMentionsFromDoc, type MentionKind } from './MentionMark'
import { GiphyPicker } from './GiphyPicker'
import { Huddle } from './Huddle'
import { isTranscriptPayload, TranscriptCard } from './Transcript'
import { RightSidebar, useRightSidebar } from './RightSidebar'
import { useModal } from './Modal'
import {
  ALargeSmall,
  AtSign,
  Bold,
  Archive,
  Bell,
  ChevronDown,
  MoreVertical,
  Pencil,
  Search,
  Settings,
  Trash2,
  SmilePlus,
  Code,
  FileCode,
  FileText,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  MessageSquare,
  Headphones,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pin,
  PinOff,
  Plus,
  Quote,
  SendHorizontal,
  Slash,
  Smile,
  Strikethrough,
  Underline,
  Upload,
  Video,
  X,
} from 'lucide-react'
import {
  APIError,
  uploadAttachment,
  useArchiveChannel,
  useChangeMyPassword,
  useChannels,
  useDeleteChannel,
  useDeleteMessage,
  useEditMessage,
  useSearchMessages,
  useToggleReaction,
  useTypingNotifier,
  useTypingState,
  usePinMessage,
  useUnpinMessage,
  useChannelPins,
  useMyMentions,
  useMarkMentionsRead,
  useWorkspaceMentionCounts,
  getSlashCommand,
  listSlashCommands,
  parseSlashInput,
  type SlashCommand,
  type SlashCommandContext,
  type MentionNotification,
  useCreateChannel,
  useCreateWorkspaceInvite,
  useDMs,
  useJoinChannel,
  useLeaveChannel,
  useLogout,
  useMembers,
  useMessages,
  useMyWorkspaces,
  usePostMessage,
  usePublicChannels,
  useRealtime,
  useRevokeWorkspaceInvite,
  usePostThreadReply,
  useStartDM,
  useThreadReplies,
  useUpdateMe,
  uploadAvatar,
  useWorkspaceInvites,
  useUnreadCounts,
  useMarkChannelRead,
  setActiveChannel,
  setCurrentUser,
  type MessagesInfiniteData,
  type UnreadMap,
} from '@stack/client'
import type {
  AttachmentFile,
  Channel,
  DMSummary,
  Invite,
  InviteWithToken,
  Member,
  Message,
  User,
} from '@stack/client'

type Props = {
  user: User
  // Controlled (router-driven) selection. If absent, falls back to internal state.
  activeWorkspaceSlug?: string | null
  activeChannelId?: string | null
  onSelectWorkspace?: (slug: string) => void
  onSelectChannel?: (slug: string, channelId: string) => void
  onOpenDashboard?: () => void
}

export function Chat({
  user,
  activeWorkspaceSlug = null,
  activeChannelId = null,
  onSelectWorkspace,
  onSelectChannel,
  onOpenDashboard,
}: Props) {
  const { data: workspaces, isLoading: wsLoading, error: wsError } = useMyWorkspaces()
  const [internalSlug, setInternalSlug] = useState<string | null>(null)
  const [internalChannelId, setInternalChannelId] = useState<string | null>(null)
  const [showInvites, setShowInvites] = useState(false)
  // When a search result is clicked, we set this to {channelId, messageId};
  // ChannelView/MessageList consume it to anchor-load + scroll-to + briefly
  // highlight the target. Cleared by MessageList after the scroll lands so
  // re-clicking the same result re-triggers the scroll.
  const [scrollTarget, setScrollTarget] = useState<{
    channelId: string
    messageId: string
  } | null>(null)
  // Just-started DMs we haven't yet sent a message in. The server hides them
  // from useDMs (no messages yet) so the recipient doesn't see them; we keep
  // them locally so the initiator can see + select their fresh DM in the
  // sidebar before they post the first message.
  const [pendingDMs, setPendingDMs] = useState<DMSummary[]>([])
  const [showSettings, setShowSettings] = useState(false)
  // Cmd+/ (Ctrl+/ on Linux/Win) collapses the left nav. Default open.
  const [leftNavOpen, setLeftNavOpen] = useState(true)
  const logout = useLogout()
  const rtState = useRealtime()
  // Right-side sidebar slot — threads, soon other things. Cleared on channel
  // change so a thread from the previous channel doesn't linger.
  const sidebar = useRightSidebar()
  // Modal slot — workspace members list, future confirm dialogs, etc.
  const modal = useModal()

  // Global hotkey: Cmd+/ on Mac, Ctrl+/ on others, toggles the left nav.
  // Bound on window so it works anywhere in the chat — including while
  // typing in the composer.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setLeftNavOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Resolve effective workspace slug (controlled prop wins).
  const slug = activeWorkspaceSlug ?? internalSlug

  // Auto-select first workspace if nothing in URL or state.
  useEffect(() => {
    if (slug) return
    if (workspaces && workspaces.length > 0) {
      const firstSlug = workspaces[0]!.slug
      if (onSelectWorkspace) onSelectWorkspace(firstSlug)
      else setInternalSlug(firstSlug)
    }
  }, [slug, workspaces, onSelectWorkspace])

  const { data: channels } = useChannels(slug)
  const { data: members } = useMembers(slug)
  const { data: dms } = useDMs(slug)
  const { data: unread } = useUnreadCounts(slug)
  const { data: mentionCounts } = useWorkspaceMentionCounts(slug)
  const markRead = useMarkChannelRead(slug)

  // Tell the realtime patcher who we are + which channel is in view so it
  // can skip bumping unread for our own sends and for the active channel.
  useEffect(() => {
    setCurrentUser(user.id)
    return () => setCurrentUser(null)
  }, [user.id])

  // Drop any pendingDM the server now reports — first message just landed.
  useEffect(() => {
    if (!dms || pendingDMs.length === 0) return
    const realIDs = new Set(dms.map((d) => d.id))
    if (pendingDMs.some((p) => realIDs.has(p.id))) {
      setPendingDMs((cur) => cur.filter((p) => !realIDs.has(p.id)))
    }
  }, [dms, pendingDMs])

  // Reset pending DMs when switching workspaces — they're workspace-scoped.
  useEffect(() => {
    setPendingDMs([])
  }, [slug])

  // Close any open thread when the channel changes — the parent message
  // belongs to the previous channel and would not be in the new one's list.
  useEffect(() => {
    sidebar.close()
    // sidebar identity stable per provider; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannelId, internalChannelId])

  // Resolve effective channel id (controlled prop wins).
  const channelId = activeChannelId ?? internalChannelId

  // Tell the realtime patcher which channel is in view, and mark it read on
  // activation so the badge clears as soon as the user opens the channel.
  useEffect(() => {
    setActiveChannel(channelId)
    if (channelId) markRead.mutate(channelId)
    return () => setActiveChannel(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])

  // Auto-select #general (or first channel) when channels load and nothing selected.
  useEffect(() => {
    if (channelId) return
    if (!slug || !channels || channels.length === 0) return
    const general = channels.find((c) => c.slug === 'general')
    const target = (general ?? channels[0])!.id
    if (onSelectChannel) onSelectChannel(slug, target)
    else setInternalChannelId(target)
  }, [channelId, slug, channels, onSelectChannel])

  // If selected channel disappears from the user's lists (left it, archived,
  // DM removed), clear so auto-select picks a new one.
  useEffect(() => {
    if (!channelId || !channels) return
    const inChannels = channels.find((c) => c.id === channelId)
    const inDMs = (dms ?? []).find((d) => d.id === channelId)
    const inPending = pendingDMs.find((d) => d.id === channelId)
    if (inChannels || inDMs || inPending) return
    if (onSelectChannel && slug && channels.length > 0) {
      const fallback = channels.find((c) => c.slug === 'general') ?? channels[0]!
      onSelectChannel(slug, fallback.id)
    } else {
      setInternalChannelId(null)
    }
  }, [channelId, channels, dms, pendingDMs, slug, onSelectChannel])

  if (wsError) {
    return <FullPageError message={String(wsError)} />
  }
  if (wsLoading) return <FullPageMessage>Loading…</FullPageMessage>
  if (!workspaces || workspaces.length === 0) {
    return (
      <FullPageMessage>
        You don't belong to any workspace yet. Accept an invite or have one created for you.
      </FullPageMessage>
    )
  }

  const namedActive = channels?.find((c) => c.id === channelId) ?? null
  const dmActive =
    (dms ?? []).find((d) => d.id === channelId) ??
    pendingDMs.find((d) => d.id === channelId) ??
    null
  // Synthesize a Channel from a DM for ChannelView. The MessageList just needs
  // the id; the header reads kind + name.
  const activeChannel: (Channel & { dm?: DMSummary }) | null = namedActive
    ? namedActive
    : dmActive
      ? {
          id: dmActive.id,
          workspace_id: '', // unused by ChannelView
          kind: dmActive.kind,
          name: dmLabel(dmActive),
          archived: false,
          dm: dmActive,
        }
      : null
  const myMembership = members?.find((m) => m.user_id === user.id) ?? null
  const isWorkspaceAdmin =
    myMembership?.role === 'owner' || myMembership?.role === 'admin'

  // openUserInfo populates the right sidebar with a UserInfoView for the
  // given user. Defined here so all triggers (message author clicks, DM list
  // avatar clicks, members-modal rows) go through one path with consistent
  // close + DM-start behavior.
  function openUserInfo(userId: string) {
    if (!slug) return
    sidebar.open({
      id: `user:${userId}`,
      title: 'User info',
      body: (
        <UserInfoView
          userId={userId}
          workspaceSlug={slug}
          currentUserID={user.id}
          onStartDM={(channelId) => {
            sidebar.close()
            handleSelectChannel(channelId)
          }}
        />
      ),
    })
  }

  // openMentionsPanel populates the right sidebar with the recent-mentions
  // feed (bell-icon click). Lives at the Chat-shell level so it can route
  // jumps via handleSelectChannel — same path search results use.
  function openMentionsPanel() {
    sidebar.open({
      id: 'mentions',
      title: 'Recent mentions',
      body: (
        <MentionsListView
          workspaceSlug={slug}
          memberMap={
            new Map((members ?? []).map((m) => [m.user_id, m]))
          }
          onJump={(channelId, messageId) =>
            handleSelectChannel(channelId, messageId)
          }
        />
      ),
    })
  }

  // openMembersModal pops the searchable member list. Picking a member
  // closes the modal and routes through openUserInfo so the sidebar shows
  // the same profile shape every time.
  function openMembersModal() {
    modal.open({
      id: 'members',
      title: 'Workspace members',
      size: 'md',
      body: (
        <MembersModalBody
          members={members ?? []}
          onPick={(userId) => {
            modal.close()
            openUserInfo(userId)
          }}
        />
      ),
    })
  }

  function handleSelectWorkspace(nextSlug: string) {
    if (onSelectWorkspace) onSelectWorkspace(nextSlug)
    else {
      setInternalSlug(nextSlug)
      setInternalChannelId(null)
    }
  }

  function handleSelectChannel(nextChannelId: string, targetMessageId?: string) {
    if (targetMessageId) {
      setScrollTarget({ channelId: nextChannelId, messageId: targetMessageId })
    } else {
      setScrollTarget(null)
    }
    if (onSelectChannel && slug) onSelectChannel(slug, nextChannelId)
    else setInternalChannelId(nextChannelId)
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4">
        <div className="flex-1 flex justify-center">
          <SearchBar
            workspaceSlug={slug}
            channels={channels ?? []}
            dms={dms ?? []}
            pendingDMs={pendingDMs}
            onJump={(channelId) => handleSelectChannel(channelId)}
            onJumpToMessage={(channelId, messageId) =>
              handleSelectChannel(channelId, messageId)
            }
          />
        </div>
        <BellButton
          totalUnread={mentionCounts?.total ?? 0}
          onClick={openMentionsPanel}
        />
        <MembersAvatarStack members={members} onClick={openMembersModal} />
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
      {!leftNavOpen && (
        <CollapsedNavRail
          workspaceName={
            workspaces.find((w) => w.slug === slug)?.name ?? '?'
          }
          onExpand={() => setLeftNavOpen(true)}
        />
      )}
      <aside
        className={
          'flex w-[260px] shrink-0 flex-col min-h-0 overflow-hidden border-r border-zinc-800 bg-zinc-900/50 ' +
          (leftNavOpen ? '' : 'hidden')
        }
      >
        <header className="px-4 py-3 border-b border-zinc-800 space-y-2">
          <div className="flex items-center gap-2">
            <select
              value={slug ?? ''}
              onChange={(e) => handleSelectWorkspace(e.target.value)}
              className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.slug}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setLeftNavOpen(false)}
              title="Collapse sidebar (⌘/)"
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
          {isWorkspaceAdmin && slug && (
            <button
              onClick={() => setShowInvites(true)}
              className="w-full text-left text-xs text-zinc-400 hover:text-zinc-200"
            >
              Manage invites →
            </button>
          )}
        </header>
        {showInvites && slug && (
          <InvitesModal
            workspaceSlug={slug}
            onClose={() => setShowInvites(false)}
          />
        )}

        <nav className="flex-1 overflow-y-auto py-2 min-h-0">
          <ChannelList
            channels={channels}
            activeId={channelId}
            onSelect={handleSelectChannel}
            workspaceSlug={slug}
            unread={unread}
            mentionCounts={mentionCounts?.by_channel}
          />
          <DirectList
            workspaceSlug={slug}
            members={members}
            currentUserID={user.id}
            activeId={channelId}
            onSelect={handleSelectChannel}
            pendingDMs={pendingDMs}
            onAddPendingDM={(d) => setPendingDMs((cur) => [d, ...cur])}
            onRemovePendingDM={(id) =>
              setPendingDMs((cur) => cur.filter((d) => d.id !== id))
            }
            unread={unread}
            onUserClick={openUserInfo}
          />
        </nav>

        <footer className="border-t border-zinc-800 px-4 py-3 text-sm">
          {onOpenDashboard && (
            <button
              onClick={onOpenDashboard}
              className="block w-full text-left text-xs text-zinc-300 hover:text-zinc-100 mb-2"
            >
              Operator dashboard →
            </button>
          )}
          <div className="flex items-center gap-2">
            <Avatar
              src={user.avatar_url}
              name={user.display_name}
              size={32}
            />
            <div className="min-w-0 flex-1">
              <div className="text-zinc-300 truncate">{user.display_name}</div>
              <div className="text-xs text-zinc-500 truncate">{user.email}</div>
            </div>
            <button
              onClick={() => setShowSettings(true)}
              title="Settings"
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
          <button
            onClick={() => logout.mutate()}
            className="mt-2 text-xs text-zinc-400 hover:text-zinc-200"
          >
            Sign out
          </button>
        </footer>
      </aside>

      <section className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden">
        {activeChannel ? (
          <ChannelView
            channel={activeChannel}
            workspaceSlug={slug ?? ''}
            members={members}
            currentUserID={user.id}
            realtimeOpen={rtState === 'open'}
            isWorkspaceAdmin={isWorkspaceAdmin}
            onChannelGone={() => {
              // Drop local selection; the auto-select effect picks #general (or
              // the first remaining channel) once the channels query refetches.
              // URL may briefly point at the now-gone channel; the user's next
              // click on the sidebar updates it.
              setInternalChannelId(null)
            }}
            scrollTargetMessageId={
              scrollTarget && scrollTarget.channelId === activeChannel.id
                ? scrollTarget.messageId
                : null
            }
            onScrollHandled={() => setScrollTarget(null)}
            onOpenThread={(rootId) => {
              if (!activeChannel) return
              sidebar.open({
                id: `thread:${rootId}`,
                title: 'Thread',
                body: (
                  <ThreadView
                    rootId={rootId}
                    channelId={activeChannel.id}
                    workspaceSlug={slug ?? ''}
                    memberMap={
                      new Map((members ?? []).map((m) => [m.user_id, m]))
                    }
                    currentUserID={user.id}
                    onUserClick={openUserInfo}
                  />
                ),
              })
            }}
            onOpenPins={() => {
              if (!activeChannel) return
              const channelName =
                activeChannel.slug ?? activeChannel.name ?? 'channel'
              const isDM =
                activeChannel.kind === 'dm' || activeChannel.kind === 'group_dm'
              sidebar.open({
                id: `pins:${activeChannel.id}`,
                title: isDM ? 'Pinned' : `Pinned in #${channelName}`,
                body: (
                  <PinnedListView
                    channelId={activeChannel.id}
                    memberMap={
                      new Map((members ?? []).map((m) => [m.user_id, m]))
                    }
                    currentUserID={user.id}
                    onJump={(messageId) =>
                      handleSelectChannel(activeChannel.id, messageId)
                    }
                  />
                ),
              })
            }}
            onUserClick={openUserInfo}
          />
        ) : (
          <FullPageMessage>Select a channel to start chatting.</FullPageMessage>
        )}
      </section>
      <RightSidebar />
      {rtState !== 'open' && (
        <div className="absolute top-2 right-2 rounded bg-zinc-900/80 border border-zinc-700 px-2 py-1 text-xs text-zinc-400">
          {rtState === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </div>
      )}
      </div>
      {showSettings && (
        <UserSettingsModal user={user} onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}

// UserInfoView — body for the right sidebar when a user name/avatar is
// clicked. Pulls the member from the workspace members cache, falls back to
// a "user not found in this workspace" line. Offers a "Send DM" action that
// uses useStartDM, then signals the caller to close the sidebar and select
// the new channel.
function UserInfoView({
  userId,
  workspaceSlug,
  currentUserID,
  onStartDM,
}: {
  userId: string
  workspaceSlug: string
  currentUserID: string
  // Fired with the channel id once the DM is created. The caller decides
  // what to do (typically: close the sidebar + navigate to the channel).
  onStartDM: (channelId: string) => void
}) {
  const { data: members } = useMembers(workspaceSlug)
  const member = (members ?? []).find((m) => m.user_id === userId)
  const startDM = useStartDM(workspaceSlug)
  const isSelf = userId === currentUserID

  function handleStartDM() {
    if (isSelf || !member) return
    startDM.mutate(userId, { onSuccess: (channel) => onStartDM(channel.id) })
  }

  if (!member) {
    return (
      <div className="p-5 text-sm text-zinc-400">
        That user isn't a member of this workspace anymore.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-col items-center gap-3">
        <Avatar src={member.avatar_url} name={member.display_name} size={96} />
        <div className="text-center">
          <div className="text-lg font-semibold">{member.display_name}</div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            {member.role}
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
        <dt className="text-xs uppercase tracking-wide text-zinc-500">Email</dt>
        <dd className="truncate">{member.email}</dd>
        {member.joined_at && (
          <>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">Joined</dt>
            <dd>{new Date(member.joined_at).toLocaleDateString()}</dd>
          </>
        )}
      </dl>

      {!isSelf && (
        <button
          type="button"
          onClick={handleStartDM}
          disabled={startDM.isPending}
          className="rounded bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {startDM.isPending ? 'Opening…' : `Send ${member.display_name} a DM`}
        </button>
      )}
    </div>
  )
}

// BellButton — header-level shortcut to the recent-mentions panel. Renders
// a numeric badge when the user has unread mentions across the workspace.
function BellButton({
  totalUnread,
  onClick,
}: {
  totalUnread: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        totalUnread > 0
          ? `${totalUnread} unread mention${totalUnread === 1 ? '' : 's'}`
          : 'Mentions'
      }
      className="relative flex h-8 w-8 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
    >
      <Bell className="h-4 w-4" />
      {totalUnread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-amber-500 px-1 text-[10px] font-bold leading-4 text-zinc-950">
          {totalUnread > 99 ? '99+' : totalUnread}
        </span>
      )}
    </button>
  )
}

// MentionsListView — body for the RightSidebar slot when the bell icon is
// clicked. Renders newest-first unread mentions; each row jumps to the
// mentioning message. A "Mark all read" affordance clears the workspace
// without leaving the panel.
function MentionsListView({
  workspaceSlug,
  memberMap,
  onJump,
}: {
  workspaceSlug: string | null
  memberMap: Map<string, Member>
  onJump: (channelId: string, messageId: string) => void
}) {
  const { data, isLoading, error } = useMyMentions({ unread: true, limit: 50 })
  const markRead = useMarkMentionsRead()

  if (isLoading) {
    return <div className="p-5 text-sm text-zinc-500">Loading…</div>
  }
  if (error) {
    return (
      <div className="p-5 text-sm text-rose-400">
        Couldn't load mentions.
      </div>
    )
  }
  const mentions: MentionNotification[] = data?.mentions ?? []
  if (mentions.length === 0) {
    return (
      <div className="p-5 text-sm text-zinc-500">
        No unread mentions. Anyone who @-mentions you, or sends @channel /
        @everyone in a channel you're in, will show up here.
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <span className="text-xs text-zinc-500">
          {mentions.length} unread
        </span>
        {workspaceSlug && (
          <button
            type="button"
            onClick={() => {
              // workspaceSlug is the URL-friendly name; the mutation needs
              // the workspace id. We grab it from the first mention since
              // they're all in this workspace (the count endpoint scoped
              // them already).
              const wid = mentions[0]?.workspace_id
              if (wid) markRead.mutate({ workspaceId: wid })
            }}
            className="text-xs text-zinc-400 hover:text-zinc-100"
          >
            Mark all read
          </button>
        )}
      </div>
      <ul className="divide-y divide-zinc-800">
        {mentions.map((mn) => {
          const mentioner = mn.mentioner_user_id
            ? memberMap.get(mn.mentioner_user_id)
            : undefined
          const mentionerName =
            mentioner?.display_name ??
            (mn.mentioner_user_id?.slice(0, 8) ?? '(unknown user)')
          const kindLabel =
            mn.mention_kind === 'user'
              ? 'mentioned you'
              : `posted @${mn.mention_kind}`
          return (
            <li key={mn.id} className="group relative px-4 py-3 hover:bg-zinc-900/60">
              <button
                type="button"
                onClick={() => {
                  onJump(mn.channel_id, mn.message_id)
                  markRead.mutate({ id: mn.id })
                }}
                className="block w-full text-left"
              >
                <div className="flex items-center gap-2">
                  <Avatar
                    src={mentioner?.avatar_url}
                    name={mentionerName}
                    size={20}
                  />
                  <span className="text-xs">
                    <span className="font-semibold text-zinc-200">
                      {mentionerName}
                    </span>{' '}
                    <span className="text-zinc-400">{kindLabel}</span>
                  </span>
                  <span className="ml-auto text-[11px] text-zinc-500">
                    {timeAgo(mn.created_at)}
                  </span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => markRead.mutate({ id: mn.id })}
                title="Mark read"
                className="absolute right-3 top-3 hidden h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 group-hover:flex"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// PinnedListView — body for the RightSidebar slot when the Pin icon is
// clicked. Renders a flat list of pinned messages in the channel, newest-
// pinned first. Each row is clickable and jumps to the message inline (via
// the same anchor-scroll mechanism search results use).
function PinnedListView({
  channelId,
  memberMap,
  currentUserID,
  onJump,
}: {
  channelId: string
  memberMap: Map<string, Member>
  currentUserID: string
  onJump: (messageId: string) => void
}) {
  const { data, isLoading, error } = useChannelPins(channelId)
  const unpinMut = useUnpinMessage(channelId)

  if (isLoading) {
    return <div className="p-5 text-sm text-zinc-500">Loading…</div>
  }
  if (error) {
    return (
      <div className="p-5 text-sm text-rose-400">
        Couldn't load pinned messages.
      </div>
    )
  }
  const messages = data?.messages ?? []
  if (messages.length === 0) {
    return (
      <div className="p-5 text-sm text-zinc-500">
        Nothing pinned in this channel yet. Hit the pin icon on any message
        — or press <kbd className="rounded bg-zinc-800 px-1">p</kbd> with a
        message selected.
      </div>
    )
  }

  return (
    <ul className="divide-y divide-zinc-800">
      {messages.map((m) => {
        const author = m.user_id ? memberMap.get(m.user_id) : undefined
        const authorName = author?.display_name ?? '(unknown user)'
        const pinnerName = m.pinned_by_user_id
          ? memberMap.get(m.pinned_by_user_id)?.display_name ??
            (m.pinned_by_user_id === currentUserID ? 'you' : null)
          : null
        return (
          <li key={m.id} className="group relative px-4 py-3 hover:bg-zinc-900/60">
            <button
              type="button"
              onClick={() => onJump(m.id)}
              className="block w-full text-left"
            >
              <div className="flex items-center gap-2">
                <Avatar src={author?.avatar_url} name={authorName} size={20} />
                <span className="text-xs font-semibold text-zinc-200">
                  {authorName}
                </span>
                <span className="text-[11px] text-zinc-500">
                  {new Date(m.created_at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              </div>
              <p className="mt-1 line-clamp-3 break-words text-sm text-zinc-300">
                {pinSnippet(m)}
              </p>
              {pinnerName && (
                <p className="mt-1 text-[11px] text-amber-400/80">
                  Pinned by {pinnerName}
                </p>
              )}
            </button>
            <button
              type="button"
              onClick={() => unpinMut.mutate({ messageId: m.id })}
              title="Unpin"
              className="absolute right-3 top-3 hidden h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-amber-300 group-hover:flex"
            >
              <PinOff className="h-4 w-4" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// pinSnippet pulls a short text preview out of a message — prefer plain text;
// fall back to walking the TipTap payload for the first text node. Keeps the
// pinned-list rows readable even for rich content.
function pinSnippet(m: Message): string {
  if (m.text && m.text.trim() !== '') return m.text
  const payload = m.payload as { content?: unknown[] } | undefined
  if (payload?.content) {
    const buf: string[] = []
    walkText(payload as { content?: unknown[] }, buf)
    const joined = buf.join(' ').trim()
    if (joined) return joined
  }
  if (m.attachments && m.attachments.length > 0) {
    return `[${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}]`
  }
  return '(empty message)'
}

function walkText(node: { content?: unknown[]; text?: string }, out: string[]) {
  if (typeof node.text === 'string') out.push(node.text)
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      walkText(child as { content?: unknown[]; text?: string }, out)
    }
  }
}

// MembersAvatarStack — header-level summary of workspace members. Renders
// up to MAX_VISIBLE overlapping avatars, then a "+N" pill, then opens the
// full searchable list in a modal on click.
function MembersAvatarStack({
  members,
  onClick,
}: {
  members: Member[] | undefined
  onClick: () => void
}) {
  if (!members || members.length === 0) return null
  const MAX_VISIBLE = 3
  const visible = members.slice(0, MAX_VISIBLE)
  const extra = members.length - visible.length
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${members.length} workspace ${members.length === 1 ? 'member' : 'members'} — click to view all`}
      className="flex items-center gap-2 rounded px-2 py-1 hover:bg-zinc-800"
    >
      <div className="flex -space-x-2">
        {visible.map((m) => (
          <div key={m.user_id} className="ring-2 ring-zinc-900 rounded-md">
            <Avatar src={m.avatar_url} name={m.display_name} size={24} />
          </div>
        ))}
      </div>
      {extra > 0 && (
        <span className="text-xs font-medium text-zinc-400">+{extra}</span>
      )}
    </button>
  )
}

// MembersModalBody — full searchable workspace member list. Clicking a row
// closes the modal (parent passes onPick) and opens the user-info sidebar.
function MembersModalBody({
  members,
  onPick,
}: {
  members: Member[]
  onPick: (userId: string) => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const filtered = q
    ? members.filter(
        (m) =>
          m.display_name.toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q),
      )
    : members
  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="border-b border-zinc-800 p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          placeholder="Search members"
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm outline-none focus:border-sky-500"
        />
      </div>
      <ul className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 ? (
          <li className="px-4 py-6 text-center text-sm text-zinc-500">
            No matches.
          </li>
        ) : (
          filtered.map((m) => (
            <li key={m.user_id}>
              <button
                type="button"
                onClick={() => onPick(m.user_id)}
                className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-zinc-800"
              >
                <Avatar src={m.avatar_url} name={m.display_name} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{m.display_name}</div>
                  <div className="truncate text-xs text-zinc-500">{m.email}</div>
                </div>
                <span className="text-xs text-zinc-600">{m.role}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

// CollapsedNavRail — the thin sidebar shown when the left nav is collapsed.
// Slack-style minimal rail: just the workspace badge + an expand button. Keeps
// a visible anchor so the user has somewhere to click to bring the sidebar
// back without remembering Cmd+/.
function CollapsedNavRail({
  workspaceName,
  onExpand,
}: {
  workspaceName: string
  onExpand: () => void
}) {
  const initial = workspaceName.trim().charAt(0).toUpperCase() || '?'
  return (
    <aside className="flex w-12 shrink-0 flex-col items-center gap-2 border-r border-zinc-800 bg-zinc-900/50 py-3">
      <div
        title={workspaceName}
        className="flex h-8 w-8 items-center justify-center rounded-md bg-zinc-800 text-sm font-semibold"
      >
        {initial}
      </div>
      <button
        type="button"
        onClick={onExpand}
        title="Expand sidebar (⌘/)"
        className="flex h-8 w-8 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
      >
        <PanelLeftOpen className="h-4 w-4" />
      </button>
    </aside>
  )
}

// Avatar — shows the user's image when available, or a coloured initials
// fallback when not. Server resigns `src` on every fetch, so we don't worry
// about expiry here.
function Avatar({
  src,
  name,
  size = 24,
  className = '',
}: {
  src?: string
  name: string
  size?: number
  className?: string
}) {
  const initials = useMemo(() => initialsOf(name), [name])
  const bg = useMemo(() => colorFromString(name), [name])
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) }
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        style={style}
        className={`rounded-md object-cover bg-zinc-800 ${className}`}
      />
    )
  }
  return (
    <div
      style={{ ...style, backgroundColor: bg }}
      className={`flex items-center justify-center rounded-md font-semibold text-zinc-900 ${className}`}
    >
      {initials}
    </div>
  )
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

// Stable hash → hue. Avatars stay the same colour for a given name across
// reloads, which makes scanning a member list easier.
function colorFromString(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  const hue = Math.abs(h) % 360
  return `hsl(${hue}, 65%, 70%)`
}

function UserSettingsModal({
  user,
  onClose,
}: {
  user: User
  onClose: () => void
}) {
  const [tab, setTab] = useState<'profile' | 'security'>('profile')
  const [displayName, setDisplayName] = useState(user.display_name)
  const [timezone, setTimezone] = useState(user.timezone)
  // Local preview URL while the upload is in flight; cleared once the server
  // round-trip returns the new resigned URL on `me`.
  const [previewURL, setPreviewURL] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const updateMe = useUpdateMe()
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Browser-side timezone list — caller's runtime is the authoritative source.
  // Falls back to a minimal hand-curated list on older browsers.
  const timezones = useMemo<string[]>(() => {
    type IntlWithSupportedTZ = typeof Intl & {
      supportedValuesOf?: (key: 'timeZone') => string[]
    }
    const i = Intl as IntlWithSupportedTZ
    if (typeof i.supportedValuesOf === 'function') {
      return i.supportedValuesOf('timeZone')
    }
    return ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo']
  }, [])

  async function handleFileChosen(file: File) {
    setError(null)
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file.')
      return
    }
    setUploading(true)
    const localPreview = URL.createObjectURL(file)
    setPreviewURL(localPreview)
    try {
      const objectKey = await uploadAvatar(file)
      await updateMe.mutateAsync({ avatar_object_key: objectKey })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
      setPreviewURL(null)
      URL.revokeObjectURL(localPreview)
    } finally {
      setUploading(false)
    }
  }

  async function handleSave() {
    setError(null)
    const changes: { display_name?: string; timezone?: string } = {}
    if (displayName.trim() !== user.display_name) {
      changes.display_name = displayName.trim()
    }
    if (timezone !== user.timezone) {
      changes.timezone = timezone
    }
    if (Object.keys(changes).length === 0) {
      onClose()
      return
    }
    try {
      await updateMe.mutateAsync(changes)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    }
  }

  function handleRemoveAvatar() {
    setError(null)
    setPreviewURL(null)
    updateMe.mutate({ avatar_object_key: '' })
  }

  const showAvatarSrc = previewURL ?? user.avatar_url

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-100">User settings</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* tab strip ---------------------------------------------------------- */}
        <div className="mb-4 flex gap-1 border-b border-zinc-800 text-sm">
          <SettingsTabButton active={tab === 'profile'} onClick={() => setTab('profile')}>
            Profile
          </SettingsTabButton>
          <SettingsTabButton active={tab === 'security'} onClick={() => setTab('security')}>
            Security
          </SettingsTabButton>
        </div>

        {tab === 'security' ? (
          <ChangePasswordForm onCancel={onClose} />
        ) : (
        <>
        {/* avatar block ------------------------------------------------------ */}
        <div className="mb-5 flex items-center gap-4">
          <Avatar src={showAvatarSrc} name={displayName || user.display_name} size={64} />
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              {uploading ? 'Uploading…' : 'Upload image'}
            </button>
            {(user.avatar_url || previewURL) && !uploading && (
              <button
                type="button"
                onClick={handleRemoveAvatar}
                className="text-left text-xs text-zinc-500 hover:text-rose-400"
              >
                Remove
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleFileChosen(f)
              e.target.value = ''
            }}
          />
        </div>

        {/* display name ----------------------------------------------------- */}
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-zinc-400">Display name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={80}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
          />
        </label>

        {/* email (read-only) ------------------------------------------------ */}
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-zinc-400">Email</span>
          <input
            value={user.email}
            disabled
            className="w-full cursor-not-allowed rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-500"
          />
        </label>

        {/* timezone --------------------------------------------------------- */}
        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-medium text-zinc-400">Timezone</span>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
          >
            {timezones.includes(timezone) ? null : <option value={timezone}>{timezone}</option>}
            {timezones.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        </label>

        {error && <div className="mb-3 text-xs text-rose-400">{error}</div>}

        <footer className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={updateMe.isPending || uploading}
            className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {updateMe.isPending ? 'Saving…' : 'Save'}
          </button>
        </footer>
        </>
        )}
      </div>
    </div>
  )
}

function SettingsTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        '-mb-px border-b-2 px-3 py-2 transition-colors ' +
        (active
          ? 'border-sky-500 text-zinc-100'
          : 'border-transparent text-zinc-400 hover:text-zinc-200')
      }
    >
      {children}
    </button>
  )
}

// ChangePasswordForm — Security tab body. Validates new === confirm + length
// ≥ 8 client-side; server rejects (401) on wrong current_password and (400)
// on policy violations. Session cookie stays valid after a successful change.
function ChangePasswordForm({ onCancel }: { onCancel: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [success, setSuccess] = useState(false)
  const [localErr, setLocalErr] = useState<string | null>(null)
  const change = useChangeMyPassword()

  // Server-error mapping: 401 means current_password didn't match.
  const wrongCurrent = change.error instanceof APIError && change.error.status === 401
  const policyError = change.error instanceof APIError && change.error.status === 400
  const otherError =
    change.error && !wrongCurrent && !policyError ? String(change.error) : null

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLocalErr(null)
    setSuccess(false)
    if (next.length < 8) {
      setLocalErr('New password must be at least 8 characters.')
      return
    }
    if (next !== confirm) {
      setLocalErr('New password and confirmation do not match.')
      return
    }
    change.mutate(
      { current_password: current, new_password: next },
      {
        onSuccess: () => {
          setSuccess(true)
          setCurrent('')
          setNext('')
          setConfirm('')
        },
      },
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-zinc-400">Current password</span>
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
        />
        {wrongCurrent && (
          <span className="mt-1 block text-xs text-rose-400">Current password is incorrect.</span>
        )}
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-zinc-400">New password</span>
        <input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
        />
        {policyError && (
          <span className="mt-1 block text-xs text-rose-400">{String(change.error)}</span>
        )}
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-zinc-400">Confirm new password</span>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
        />
      </label>

      {localErr && <div className="text-xs text-rose-400">{localErr}</div>}
      {otherError && <div className="text-xs text-rose-400">{otherError}</div>}
      {success && <div className="text-xs text-emerald-400">Password updated.</div>}

      <footer className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={change.isPending}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {change.isPending ? 'Updating…' : 'Update password'}
        </button>
      </footer>
    </form>
  )
}

function ChannelList({
  channels,
  activeId,
  onSelect,
  workspaceSlug,
  unread,
  mentionCounts,
}: {
  channels?: Channel[]
  activeId: string | null
  onSelect: (id: string) => void
  workspaceSlug: string | null
  unread?: UnreadMap
  // Per-channel unread mention counts. Keyed by channel id. A channel with
  // both unread messages and unread mentions shows both badges (mention
  // badge wins visual prominence — amber on rose).
  mentionCounts?: Record<string, number>
}) {
  const [showCreate, setShowCreate] = useState(false)
  const [showBrowse, setShowBrowse] = useState(false)

  return (
    <section>
      <div className="flex items-center justify-between px-4 pt-2 pb-1">
        <h2 className="text-xs uppercase tracking-wider text-zinc-500">Channels</h2>
        <div className="flex gap-1">
          <button
            onClick={() => setShowBrowse(true)}
            disabled={!workspaceSlug}
            className="text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
            title="Browse public channels"
          >
            Browse
          </button>
          <button
            onClick={() => setShowCreate(true)}
            disabled={!workspaceSlug}
            className="text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
            title="Create channel"
          >
            +
          </button>
        </div>
      </div>

      {!channels ? (
        <div className="px-4 py-2 text-sm text-zinc-500">Loading…</div>
      ) : channels.length === 0 ? (
        <div className="px-4 py-2 text-sm text-zinc-500">No channels yet.</div>
      ) : (
        <ul>
          {channels.map((c) => {
            const active = c.id === activeId
            // Active channel always renders as "read" — markRead fires on
            // activation, but the count cache may not have caught up yet.
            const unreadCount = active ? 0 : unread?.[c.id] ?? 0
            const hasUnread = unreadCount > 0
            const mentionCount = active ? 0 : mentionCounts?.[c.id] ?? 0
            return (
              <li key={c.id}>
                <button
                  onClick={() => onSelect(c.id)}
                  className={
                    'flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm transition-colors ' +
                    (active
                      ? 'bg-zinc-800 text-zinc-100'
                      : hasUnread
                        ? 'font-semibold text-zinc-100 hover:bg-zinc-800/50'
                        : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200')
                  }
                >
                  <span className="text-zinc-500">#</span>
                  <span className="flex-1 truncate">{c.slug ?? '(dm)'}</span>
                  {c.archived && (
                    <span className="text-xs text-zinc-600">archived</span>
                  )}
                  {mentionCount > 0 && (
                    <span
                      title={`${mentionCount} unread mention${mentionCount === 1 ? '' : 's'}`}
                      className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-zinc-950"
                    >
                      @{mentionCount > 99 ? '99+' : mentionCount}
                    </span>
                  )}
                  {hasUnread && (
                    <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {showCreate && workspaceSlug && (
        <CreateChannelModal
          workspaceSlug={workspaceSlug}
          onClose={() => setShowCreate(false)}
          onCreated={(c) => {
            setShowCreate(false)
            onSelect(c.id)
          }}
        />
      )}
      {showBrowse && workspaceSlug && (
        <BrowseChannelsModal
          workspaceSlug={workspaceSlug}
          alreadyJoined={new Set((channels ?? []).map((c) => c.id))}
          onClose={() => setShowBrowse(false)}
          onJoined={(c) => onSelect(c.id)}
        />
      )}
    </section>
  )
}

function CreateChannelModal({
  workspaceSlug,
  onClose,
  onCreated,
}: {
  workspaceSlug: string
  onClose: () => void
  onCreated: (c: Channel) => void
}) {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'public' | 'private'>('public')
  const create = useCreateChannel(workspaceSlug)

  return (
    <ModalShell title="Create channel" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate(
            { slug, name: name || undefined, kind },
            {
              onSuccess: (channel) => onCreated(channel),
            },
          )
        }}
        className="space-y-3"
      >
        <ModalField label="Slug" hint="lowercase letters/digits/hyphens, e.g. random">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            required
            className={modalInputClass}
          />
        </ModalField>
        <ModalField label="Name (optional)" hint="defaults to slug">
          <input value={name} onChange={(e) => setName(e.target.value)} className={modalInputClass} />
        </ModalField>
        <ModalField label="Kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'public' | 'private')}
            className={modalInputClass}
          >
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
        </ModalField>
        {create.error && <p className="text-sm text-rose-400">{String(create.error)}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded bg-zinc-100 text-zinc-900 px-3 py-1.5 text-sm font-medium hover:bg-white disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

function BrowseChannelsModal({
  workspaceSlug,
  alreadyJoined,
  onClose,
  onJoined,
}: {
  workspaceSlug: string
  alreadyJoined: Set<string>
  onClose: () => void
  onJoined: (c: Channel) => void
}) {
  const { data: channels, isLoading, error } = usePublicChannels(workspaceSlug)
  const join = useJoinChannel(workspaceSlug)

  return (
    <ModalShell title="Browse public channels" onClose={onClose}>
      {isLoading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : error ? (
        <div className="text-sm text-rose-400">Error: {String(error)}</div>
      ) : !channels || channels.length === 0 ? (
        <div className="text-sm text-zinc-500">No public channels in this workspace.</div>
      ) : (
        <ul className="divide-y divide-zinc-800 max-h-96 overflow-y-auto">
          {channels.map((c) => {
            const joined = alreadyJoined.has(c.id)
            return (
              <li key={c.id} className="py-2 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-zinc-200 truncate">
                    <span className="text-zinc-500">#</span>
                    {c.slug ?? c.name}
                  </div>
                  {c.topic && <div className="text-xs text-zinc-500 truncate">{c.topic}</div>}
                </div>
                {joined ? (
                  <span className="text-xs text-zinc-500 ml-3">Joined</span>
                ) : (
                  <button
                    onClick={() =>
                      join.mutate(c.id, {
                        onSuccess: () => {
                          onJoined(c)
                          onClose()
                        },
                      })
                    }
                    disabled={join.isPending}
                    className="ml-3 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Join
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {join.error && <p className="mt-3 text-sm text-rose-400">{String(join.error)}</p>}
      <div className="flex justify-end pt-3">
        <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">
          Close
        </button>
      </div>
    </ModalShell>
  )
}

function DirectList({
  workspaceSlug,
  members,
  currentUserID,
  activeId,
  onSelect,
  pendingDMs,
  onAddPendingDM,
  onRemovePendingDM,
  unread,
  onUserClick,
}: {
  workspaceSlug: string | null
  members: Member[] | undefined
  currentUserID: string
  activeId: string | null
  onSelect: (id: string) => void
  pendingDMs: DMSummary[]
  onAddPendingDM: (d: DMSummary) => void
  onRemovePendingDM: (id: string) => void
  unread?: UnreadMap
  // For 1:1 DMs, clicking the peer avatar opens the user-info sidebar
  // instead of selecting the channel. Group DMs ignore it.
  onUserClick?: (userId: string) => void
}) {
  const { data: dms, isLoading } = useDMs(workspaceSlug)
  const startDM = useStartDM(workspaceSlug)
  const leave = useLeaveChannel(workspaceSlug)
  const [showStart, setShowStart] = useState(false)

  function handleStart(targetMember: Member) {
    startDM.mutate(targetMember.user_id, {
      onSuccess: (channel) => {
        setShowStart(false)
        // Synthesize a sidebar entry so the initiator can see the just-opened
        // DM. Server hides empty DMs from useDMs, so without this it'd render
        // nothing in the sidebar until the first message is posted.
        onAddPendingDM({
          id: channel.id,
          kind: 'dm',
          other_user_ids: [targetMember.user_id],
          other_display_names: [targetMember.display_name],
          other_emails: [targetMember.email],
        })
        onSelect(channel.id)
      },
    })
  }

  function handleClose(d: DMSummary) {
    if (!confirm(`Close conversation with ${dmLabel(d)}? You can re-open it any time.`)) return
    // Pending DMs aren't on the server yet — just drop locally.
    if (pendingDMs.find((p) => p.id === d.id)) {
      onRemovePendingDM(d.id)
      return
    }
    leave.mutate(d.id)
  }

  // Merge real + pending; pending shown first so a brand-new DM lands at top.
  const realIDs = new Set((dms ?? []).map((d) => d.id))
  const visiblePending = pendingDMs.filter((p) => !realIDs.has(p.id))
  const merged: DMSummary[] = [...visiblePending, ...(dms ?? [])]
  const memberMap = new Map((members ?? []).map((m) => [m.user_id, m]))

  return (
    <section className="mt-4">
      <div className="flex items-center justify-between px-4 pt-2 pb-1">
        <h2 className="text-xs uppercase tracking-wider text-zinc-500">Direct</h2>
        <button
          onClick={() => setShowStart(true)}
          disabled={!workspaceSlug}
          className="text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
          title="Start a direct message"
        >
          +
        </button>
      </div>

      {isLoading && merged.length === 0 ? (
        <div className="px-4 py-2 text-sm text-zinc-500">Loading…</div>
      ) : merged.length === 0 ? (
        <div className="px-4 py-2 text-xs text-zinc-500">No DMs yet.</div>
      ) : (
        <ul>
          {merged.map((d) => {
            const active = d.id === activeId
            const label = dmLabel(d)
            // For 1:1 DMs, pull the other user's avatar from the workspace
            // members map. Group DMs fall back to initials.
            const peer =
              d.kind === 'dm' && d.other_user_ids.length === 1
                ? memberMap.get(d.other_user_ids[0]!)
                : undefined
            const unreadCount = active ? 0 : unread?.[d.id] ?? 0
            const hasUnread = unreadCount > 0
            return (
              <li key={d.id} className="group relative flex items-center">
                <button
                  onClick={() => onSelect(d.id)}
                  className={
                    'flex flex-1 items-center gap-2 pr-4 py-1 text-left text-sm transition-colors ' +
                    (active
                      ? 'bg-zinc-800 text-zinc-100'
                      : hasUnread
                        ? 'font-semibold text-zinc-100 hover:bg-zinc-800/50'
                        : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200')
                  }
                  title={d.other_emails.join(', ')}
                >
                  {peer && onUserClick ? (
                    // 1:1 DM with a known peer — clicking the avatar opens
                    // user info. Pull it out of the outer button (HTML
                    // forbids nested buttons) and into a sibling that
                    // stopPropagation's so it doesn't also select the DM.
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation()
                        onUserClick(peer.user_id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          onUserClick(peer.user_id)
                        }
                      }}
                      title={`Open ${label}'s user info`}
                      className="ml-4 shrink-0 cursor-pointer rounded-md hover:opacity-80"
                    >
                      <Avatar src={peer.avatar_url} name={label} size={20} />
                    </span>
                  ) : (
                    <Avatar
                      src={peer?.avatar_url}
                      name={label}
                      size={20}
                      className="ml-4 shrink-0"
                    />
                  )}
                  <span className="flex-1 truncate">{label}</span>
                  {hasUnread && (
                    <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => handleClose(d)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity px-2 text-xs text-zinc-500 hover:text-rose-400"
                  title="Close this conversation"
                  aria-label={`Close conversation with ${label}`}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {showStart && workspaceSlug && (
        <StartDMModal
          members={members ?? []}
          currentUserID={currentUserID}
          onClose={() => setShowStart(false)}
          onStart={handleStart}
          pending={startDM.isPending}
          error={startDM.error ? String(startDM.error) : null}
        />
      )}
    </section>
  )
}

function dmLabel(d: DMSummary): string {
  if (d.other_display_names.length === 0) return '(empty)'
  if (d.other_display_names.length === 1) return d.other_display_names[0]!
  if (d.other_display_names.length <= 3) return d.other_display_names.join(', ')
  return `${d.other_display_names.slice(0, 2).join(', ')} +${d.other_display_names.length - 2}`
}

function StartDMModal({
  members,
  currentUserID,
  onClose,
  onStart,
  pending,
  error,
}: {
  members: Member[]
  currentUserID: string
  onClose: () => void
  onStart: (member: Member) => void
  pending: boolean
  error: string | null
}) {
  const [filter, setFilter] = useState('')
  const others = members.filter((m) => m.user_id !== currentUserID)
  const q = filter.trim().toLowerCase()
  const matched = q
    ? others.filter(
        (m) =>
          m.display_name.toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q),
      )
    : others

  return (
    <ModalShell title="Start a direct message" onClose={onClose}>
      <input
        autoFocus
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by name or email…"
        className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
      />
      <ul className="mt-3 max-h-80 overflow-y-auto divide-y divide-zinc-800">
        {matched.length === 0 ? (
          <li className="py-3 text-sm text-zinc-500">
            {q ? 'No members match.' : 'No other members in this workspace.'}
          </li>
        ) : (
          matched.map((m) => (
            <li
              key={m.user_id}
              className="py-2 flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="text-sm text-zinc-200 truncate">{m.display_name}</div>
                <div className="text-xs text-zinc-500 truncate">{m.email}</div>
              </div>
              <button
                onClick={() => onStart(m)}
                disabled={pending}
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                Start
              </button>
            </li>
          ))
        )}
      </ul>
      {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
      <div className="flex justify-end pt-3">
        <button
          onClick={onClose}
          className="rounded px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
        >
          Close
        </button>
      </div>
    </ModalShell>
  )
}

// =============================================================================
// SEARCH BAR (top of chat)
// =============================================================================
//
// Unified bar that handles both quick-jump and full-text message search:
//   • Bare names/text  →  quick-jump suggestions across channels + DMs.
//   • "@<name>"         →  scope filter; once matched, the rest is the query.
//                          E.g. "@general bug fix" searches #general for "bug fix".
//   • Anything else with text  →  message search across all the user's channels.
//
// Click a suggestion or message result to jump to that channel.

type SearchScope =
  | { kind: 'channel'; id: string; label: string }
  | { kind: 'dm'; id: string; label: string }

type Jumpable = {
  id: string
  label: string
  kind: 'channel' | 'dm'
  prefix: '#' | '@'
}

function SearchBar({
  workspaceSlug,
  channels,
  dms,
  pendingDMs,
  onJump,
  onJumpToMessage,
}: {
  workspaceSlug: string | null
  channels: Channel[]
  dms: DMSummary[]
  pendingDMs: DMSummary[]
  onJump: (channelId: string) => void
  onJumpToMessage: (channelId: string, messageId: string) => void
}) {
  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Debounce the query value so each keystroke doesn't fire a search.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(text), 200)
    return () => window.clearTimeout(t)
  }, [text])

  // Close on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  // ── parse the input ───────────────────────────────────────────────────────
  // "@general bug fix" → scope candidate "general", residual query "bug fix".
  // "@gen"              → scope candidate "gen" (still typing the scope), no query.
  // "bug fix"           → no scope, query "bug fix".
  const parsed = useMemo(() => parseSearchInput(text, channels, dms, pendingDMs), [
    text,
    channels,
    dms,
    pendingDMs,
  ])

  // ── server-side message search ────────────────────────────────────────────
  const debouncedParsed = useMemo(
    () => parseSearchInput(debounced, channels, dms, pendingDMs),
    [debounced, channels, dms, pendingDMs],
  )
  const scopeChannelId =
    debouncedParsed.scope?.kind === 'channel' || debouncedParsed.scope?.kind === 'dm'
      ? debouncedParsed.scope.id
      : null
  const search = useSearchMessages(
    workspaceSlug,
    debouncedParsed.query,
    scopeChannelId,
  )

  // Pull together what to render in the dropdown.
  const jumpMatches = parsed.jumpMatches.slice(0, 6)
  const messageResults = (search.data ?? []).slice(0, 12)
  const showSearch = debouncedParsed.query.length > 0
  const totalRows = jumpMatches.length + messageResults.length

  // Reset highlight when the result set changes.
  useEffect(() => {
    setActiveIdx(0)
  }, [text, search.data])

  function commit(idx: number) {
    if (idx < jumpMatches.length) {
      const j = jumpMatches[idx]!
      onJump(j.id)
    } else {
      const m = messageResults[idx - jumpMatches.length]!
      // Message results jump to the channel AND set a scroll target so the
      // MessageList anchor-loads + scrolls to the specific message.
      onJumpToMessage(m.channel_id, m.id)
    }
    setText('')
    setOpen(false)
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false)
      ;(e.target as HTMLInputElement).blur()
      return
    }
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, Math.max(totalRows - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && totalRows > 0) {
      e.preventDefault()
      commit(activeIdx)
    }
  }

  const dropdownVisible = open && (jumpMatches.length > 0 || showSearch)

  return (
    <div ref={wrapperRef} className="relative w-full max-w-xl">
      <div className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-950/60 px-2.5 py-1.5">
        <Search className="h-4 w-4 text-zinc-500" />
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder="Search — try @channel or @user"
          className="flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          spellCheck={false}
        />
        {parsed.scope && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
            {parsed.scope.kind === 'channel' ? '#' : '@'}
            {parsed.scope.label}
          </span>
        )}
      </div>

      {dropdownVisible && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[28rem] overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 shadow-2xl">
          {jumpMatches.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wider text-zinc-500">
                Jump to
              </div>
              <ul>
                {jumpMatches.map((j, i) => (
                  <li key={j.id}>
                    <button
                      onClick={() => commit(i)}
                      onMouseEnter={() => setActiveIdx(i)}
                      className={
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ' +
                        (i === activeIdx ? 'bg-zinc-800' : 'hover:bg-zinc-800/60')
                      }
                    >
                      <span className="text-zinc-500">{j.prefix}</span>
                      <span className="text-zinc-100">{j.label}</span>
                      <span className="ml-auto text-[11px] text-zinc-500">
                        {j.kind === 'channel' ? 'channel' : 'direct'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {showSearch && (
            <>
              <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wider text-zinc-500">
                Messages
                {parsed.scope && (
                  <span className="ml-1 normal-case text-zinc-400">
                    in {parsed.scope.kind === 'channel' ? '#' : '@'}{parsed.scope.label}
                  </span>
                )}
              </div>
              {search.isLoading ? (
                <div className="px-3 py-2 text-sm text-zinc-500">Searching…</div>
              ) : search.error ? (
                <div className="px-3 py-2 text-sm text-rose-400">Search failed.</div>
              ) : messageResults.length === 0 ? (
                <div className="px-3 py-2 text-sm text-zinc-500">No matches.</div>
              ) : (
                <ul>
                  {messageResults.map((m, i) => {
                    const idx = jumpMatches.length + i
                    const ch = channels.find((c) => c.id === m.channel_id)
                    const dm = [...dms, ...pendingDMs].find((d) => d.id === m.channel_id)
                    const where =
                      ch?.slug ? `#${ch.slug}` :
                      dm ? `@${dmLabelShort(dm)}` :
                      '(channel)'
                    return (
                      <li key={m.id}>
                        <button
                          onClick={() => commit(idx)}
                          onMouseEnter={() => setActiveIdx(idx)}
                          className={
                            'flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-sm ' +
                            (idx === activeIdx ? 'bg-zinc-800' : 'hover:bg-zinc-800/60')
                          }
                        >
                          <div className="flex w-full items-center gap-2">
                            <span className="text-[11px] text-zinc-500">{where}</span>
                            <span className="ml-auto text-[11px] text-zinc-600">
                              {new Date(m.created_at).toLocaleString()}
                            </span>
                          </div>
                          <div className="line-clamp-2 text-zinc-200">{m.text}</div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// dmLabelShort renders a compact display name for a DM in search context.
function dmLabelShort(d: DMSummary): string {
  if (d.other_display_names.length === 0) return '(empty)'
  if (d.other_display_names.length === 1) return d.other_display_names[0]!
  return d.other_display_names.slice(0, 2).join(', ') +
    (d.other_display_names.length > 2 ? ` +${d.other_display_names.length - 2}` : '')
}

// parseSearchInput interprets the search text:
//   "@<name>"             → if it matches an existing channel/DM exactly, that
//                           becomes the active scope and the rest is query.
//                           If still partial, no scope; jumpMatches lists
//                           candidates filtered by that partial name.
//   anything else with @  → ignored as scope (no match), treated as query text.
//   no leading @          → query text; jump matches consider full input.
function parseSearchInput(
  raw: string,
  channels: Channel[],
  dms: DMSummary[],
  pendingDMs: DMSummary[],
): {
  scope: SearchScope | null
  query: string
  jumpMatches: Jumpable[]
} {
  const text = raw.trimStart()
  let scope: SearchScope | null = null
  let query = text
  let jumpFilter = text.toLowerCase()

  if (text.startsWith('@')) {
    // "@xxx yyy zzz" — split on first space.
    const sp = text.indexOf(' ')
    const head = sp === -1 ? text.slice(1) : text.slice(1, sp)
    const tail = sp === -1 ? '' : text.slice(sp + 1)
    const headLower = head.toLowerCase()

    // Exact match first — promotes "@general" + space to a real scope.
    const ch =
      channels.find((c) => (c.slug ?? '').toLowerCase() === headLower) ??
      channels.find((c) => (c.name ?? '').toLowerCase() === headLower)
    const dmAll = [...dms, ...pendingDMs]
    const dm = dmAll.find((d) =>
      d.other_display_names.some((n) => n.toLowerCase() === headLower),
    )

    if (ch && (sp !== -1 || head.length >= (ch.slug ?? ch.name ?? '').length)) {
      scope = { kind: 'channel', id: ch.id, label: ch.slug ?? ch.name ?? '' }
      query = tail
      jumpFilter = ''
    } else if (dm && (sp !== -1 || head.length >= dm.other_display_names[0]!.length)) {
      scope = { kind: 'dm', id: dm.id, label: dmLabelShort(dm) }
      query = tail
      jumpFilter = ''
    } else {
      // Still typing the scope name — no scope yet, narrow jumpMatches by it.
      jumpFilter = headLower
      query = '' // don't search messages while still picking a scope
    }
  }

  const jumpMatches: Jumpable[] = []
  if (jumpFilter) {
    for (const c of channels) {
      const slug = (c.slug ?? '').toLowerCase()
      const name = (c.name ?? '').toLowerCase()
      if (slug.includes(jumpFilter) || name.includes(jumpFilter)) {
        jumpMatches.push({
          id: c.id,
          label: c.slug ?? c.name ?? '(unnamed)',
          kind: 'channel',
          prefix: '#',
        })
      }
    }
    for (const d of [...dms, ...pendingDMs]) {
      if (d.other_display_names.some((n) => n.toLowerCase().includes(jumpFilter))) {
        jumpMatches.push({
          id: d.id,
          label: dmLabelShort(d),
          kind: 'dm',
          prefix: '@',
        })
      }
    }
  }

  return { scope, query: query.trim(), jumpMatches }
}

function InvitesModal({
  workspaceSlug,
  onClose,
}: {
  workspaceSlug: string
  onClose: () => void
}) {
  const { data: invites, isLoading, error } = useWorkspaceInvites(workspaceSlug)
  const create = useCreateWorkspaceInvite(workspaceSlug)
  const revoke = useRevokeWorkspaceInvite(workspaceSlug)

  const [role, setRole] = useState<'admin' | 'member' | 'guest'>('member')
  const [email, setEmail] = useState('')
  const [maxUses, setMaxUses] = useState<number>(1)
  const [expiresIn, setExpiresIn] = useState('168h') // 7 days
  const [justMinted, setJustMinted] = useState<InviteWithToken | null>(null)
  const [copied, setCopied] = useState(false)

  function handleMint(e: React.FormEvent) {
    e.preventDefault()
    create.mutate(
      {
        role,
        email: email.trim() || undefined,
        max_uses: maxUses,
        expires_in: expiresIn || undefined,
      },
      {
        onSuccess: (inv) => {
          setJustMinted(inv)
          setCopied(false)
          setEmail('')
        },
      },
    )
  }

  const inviteURL = (token: string) => `${window.location.origin}/invite/${token}`

  return (
    <ModalShell title="Workspace invites" onClose={onClose}>
      <div className="space-y-5">
        <form onSubmit={handleMint} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <ModalField label="Role">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as 'admin' | 'member' | 'guest')}
                className={modalInputClass}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="guest">Guest</option>
              </select>
            </ModalField>
            <ModalField label="Max uses">
              <input
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className={modalInputClass}
              />
            </ModalField>
          </div>
          <ModalField label="Bound email (optional)" hint="If set, only this address can redeem">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="bob@example.com"
              className={modalInputClass}
            />
          </ModalField>
          <ModalField label="Expires in" hint="Go duration (e.g. 168h, 30m). Leave blank for never.">
            <input
              value={expiresIn}
              onChange={(e) => setExpiresIn(e.target.value)}
              placeholder="168h"
              className={modalInputClass}
            />
          </ModalField>
          {create.error && <p className="text-sm text-rose-400">{String(create.error)}</p>}
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded bg-zinc-100 text-zinc-900 px-3 py-1.5 text-sm font-medium hover:bg-white disabled:opacity-50"
          >
            {create.isPending ? 'Minting…' : 'Mint invite'}
          </button>
        </form>

        {justMinted && (
          <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/30 p-3 space-y-2">
            <div className="text-xs uppercase tracking-wider text-emerald-400">
              Invite link — copy now, you won't see it again
            </div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={inviteURL(justMinted.token)}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs font-mono text-zinc-200"
              />
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(inviteURL(justMinted.token))
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs hover:bg-zinc-800"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <button
              onClick={() => setJustMinted(null)}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              Dismiss
            </button>
          </div>
        )}

        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Active invites</div>
          {isLoading ? (
            <div className="text-sm text-zinc-500">Loading…</div>
          ) : error ? (
            <div className="text-sm text-rose-400">Error: {String(error)}</div>
          ) : !invites || invites.length === 0 ? (
            <div className="text-sm text-zinc-500">No active invites.</div>
          ) : (
            <ul className="divide-y divide-zinc-800 max-h-64 overflow-y-auto">
              {invites.map((inv) => (
                <InviteRow
                  key={inv.id}
                  inv={inv}
                  onRevoke={() => {
                    if (confirm('Revoke this invite? Anyone with the link will lose access.')) {
                      revoke.mutate(inv.id)
                    }
                  }}
                  pending={revoke.isPending}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </ModalShell>
  )
}

function InviteRow({
  inv,
  onRevoke,
  pending,
}: {
  inv: Invite
  onRevoke: () => void
  pending: boolean
}) {
  const isExhausted = inv.used_count >= inv.max_uses
  const isExpired = inv.expires_at && new Date(inv.expires_at) < new Date()
  const isRevoked = !!inv.revoked_at
  const dead = isRevoked || isExhausted || isExpired
  return (
    <li className="py-2 flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm text-zinc-200 truncate">
          {inv.email ? inv.email : <span className="text-zinc-500">(any email)</span>}
          <span className="ml-2 text-xs text-zinc-500">{inv.role}</span>
        </div>
        <div className="text-xs text-zinc-500">
          {inv.used_count}/{inv.max_uses} used
          {inv.expires_at && (
            <> · expires {new Date(inv.expires_at).toLocaleString()}</>
          )}
          {isRevoked && <span className="ml-2 text-rose-400">revoked</span>}
          {!isRevoked && isExpired && <span className="ml-2 text-amber-400">expired</span>}
          {!isRevoked && !isExpired && isExhausted && <span className="ml-2 text-zinc-500">used up</span>}
        </div>
      </div>
      {!dead && (
        <button
          onClick={onRevoke}
          disabled={pending}
          className="text-xs text-rose-400 hover:text-rose-300 disabled:opacity-50"
        >
          Revoke
        </button>
      )}
    </li>
  )
}


function ChannelView({
  channel,
  workspaceSlug,
  members,
  currentUserID,
  realtimeOpen,
  scrollTargetMessageId,
  onScrollHandled,
  isWorkspaceAdmin,
  onChannelGone,
  onOpenThread,
  onOpenPins,
  onUserClick,
}: {
  channel: Channel
  workspaceSlug: string
  members?: Member[]
  currentUserID: string
  realtimeOpen: boolean
  scrollTargetMessageId: string | null
  onScrollHandled: () => void
  isWorkspaceAdmin: boolean
  onChannelGone: () => void
  onOpenThread: (rootId: string) => void
  onOpenPins: () => void
  onUserClick: (userId: string) => void
}) {
  const memberMap = new Map((members ?? []).map((m) => [m.user_id, m]))
  const isDM = channel.kind === 'dm' || channel.kind === 'group_dm'
  const typingUserIDs = useTypingState(channel.id, currentUserID)
  // Huddle overlay state. Local to the channel view — closing leaves the
  // huddle (the Huddle component fires LEAVE on unmount). Resets when the
  // user navigates to a different channel because this whole component
  // remounts with a fresh channel id.
  const [huddleOpen, setHuddleOpen] = useState(false)
  const channelLabel = `${isDM ? '@ ' : '# '}${channel.slug ?? channel.name ?? '(dm)'}`
  return (
    <>
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 px-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight truncate">
            <span className="text-zinc-500">{isDM ? '@ ' : '# '}</span>
            {channel.slug ?? channel.name ?? '(dm)'}
          </h1>
          {channel.topic && (
            <p className="text-xs text-zinc-400 leading-tight truncate">{channel.topic}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setHuddleOpen(true)}
            title="Start or join huddle"
            className="flex h-8 w-8 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Headphones className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onOpenPins}
            title="Pinned messages"
            className="flex h-8 w-8 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Pin className="h-4 w-4" />
          </button>
          {!isDM && isWorkspaceAdmin && (
            <ChannelSettingsMenu
              channel={channel}
              workspaceSlug={workspaceSlug}
              onGone={onChannelGone}
            />
          )}
        </div>
      </header>
      {huddleOpen && (
        <Huddle
          channelId={channel.id}
          channelLabel={channelLabel}
          onClose={() => setHuddleOpen(false)}
        />
      )}

      <MessageList
        channelId={channel.id}
        memberMap={memberMap}
        realtimeOpen={realtimeOpen}
        currentUserID={currentUserID}
        scrollTargetMessageId={scrollTargetMessageId}
        onScrollHandled={onScrollHandled}
        onOpenThread={onOpenThread}
        onUserClick={onUserClick}
      />
      <TypingIndicator userIDs={typingUserIDs} memberMap={memberMap} />
      <Composer
        channelId={channel.id}
        workspaceSlug={workspaceSlug}
        archived={channel.archived}
        currentUserID={currentUserID}
      />
    </>
  )
}

// ChannelSettingsMenu — gear-icon dropdown in the channel header.
// Workspace-admin gated by the parent (we don't double-check here).
// Once an action commits, the channel disappears from listings; the
// "channel disappeared" effect in <Chat> auto-navigates to a fallback.
function ChannelSettingsMenu({
  channel,
  workspaceSlug,
  onGone,
}: {
  channel: Channel
  workspaceSlug: string
  onGone: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const archive = useArchiveChannel(workspaceSlug)
  const del = useDeleteChannel(workspaceSlug)

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  function handleArchive() {
    if (!confirm(`Archive #${channel.slug ?? channel.name ?? ''}? Members will lose it from their sidebar.`)) return
    archive.mutate(channel.id, {
      onSuccess: () => {
        setOpen(false)
        onGone()
      },
    })
  }
  function handleDelete() {
    if (!confirm(
      `Delete #${channel.slug ?? channel.name ?? ''}? This is permanent — the channel and its history disappear from the UI.`,
    )) return
    del.mutate(channel.id, {
      onSuccess: () => {
        setOpen(false)
        onGone()
      },
    })
  }

  const pending = archive.isPending || del.isPending

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Channel settings"
        disabled={pending}
        className="flex h-8 w-8 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-20 w-48 rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
          <button
            onClick={handleArchive}
            disabled={pending}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
          >
            <Archive className="h-4 w-4 text-zinc-400" />
            Archive channel
          </button>
          <button
            onClick={handleDelete}
            disabled={pending}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rose-400 hover:bg-rose-950/40 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            Delete channel
          </button>
        </div>
      )}
    </div>
  )
}

function TypingIndicator({
  userIDs,
  memberMap,
}: {
  userIDs: string[]
  memberMap: Map<string, Member>
}) {
  // Reserve the row even when empty so the composer doesn't jump.
  const names = userIDs
    .map((id) => memberMap.get(id)?.display_name ?? '…')
    .filter(Boolean)
  let text = ''
  if (names.length === 1) text = `${names[0]} is typing…`
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`
  else if (names.length === 3) text = `${names[0]}, ${names[1]}, and ${names[2]} are typing…`
  else if (names.length > 3) text = `${names[0]}, ${names[1]}, and ${names.length - 2} others are typing…`
  return (
    <div className="px-4 h-5 text-xs text-zinc-500 italic" aria-live="polite">
      {text}
    </div>
  )
}

function MessageList({
  channelId,
  memberMap,
  realtimeOpen,
  currentUserID,
  scrollTargetMessageId,
  onScrollHandled,
  onOpenThread,
  onUserClick,
}: {
  channelId: string
  memberMap: Map<string, Member>
  realtimeOpen: boolean
  currentUserID: string
  scrollTargetMessageId: string | null
  onScrollHandled: () => void
  onOpenThread: (rootId: string) => void
  onUserClick: (userId: string) => void
}) {
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMessages(channelId, realtimeOpen, scrollTargetMessageId)
  // Briefly highlight the target message on arrival so the user sees the jump.
  const [highlightId, setHighlightId] = useState<string | null>(null)
  // Persistent keyboard selection — driven by Up/Down arrows. Visually
  // distinct from `highlightId` (which flashes for ~2s after a search jump).
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Flatten newest-first pages, then reverse for natural top-to-bottom rendering.
  const ordered = useMemo(() => {
    if (!data) return []
    const flat = data.pages.flatMap((p) => p.messages)
    return flat.slice().reverse()
  }, [data])

  // Arrow-key navigation through the loaded messages. Bound on window so it
  // works whether the composer is focused or not (the user explicitly asked
  // for this — it overrides TipTap's normal cursor movement). Escape clears.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Escape') {
        return
      }
      // Don't fight modifier-augmented arrows (Shift+Up for selection,
      // Cmd+Up for line jump in editors, etc.).
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.key === 'Escape') {
        if (selectedId != null) {
          e.preventDefault()
          setSelectedId(null)
        }
        return
      }
      if (ordered.length === 0) return
      const dir = e.key === 'ArrowDown' ? 1 : -1
      const curIdx = selectedId
        ? ordered.findIndex((m) => m.id === selectedId)
        : -1
      // ArrowDown past the most recent message exits message-nav and hands
      // focus back to the composer. The Composer subscribes to
      // `stack:focus-composer` and calls editor.commands.focus() on match.
      if (dir === 1 && curIdx === ordered.length - 1) {
        e.preventDefault()
        setSelectedId(null)
        window.dispatchEvent(
          new CustomEvent('stack:focus-composer', {
            detail: { channelId, mode: 'channel' },
          }),
        )
        return
      }
      e.preventDefault()
      // Hand focus from the composer/editor to message-nav mode. Without
      // this, the TipTap contentEditable keeps focus, so the next plain
      // keystroke (e.g. 'p' to pin, 'e' to edit) gets swallowed as a
      // character insert before our window handlers see it.
      const active = document.activeElement as HTMLElement | null
      if (active && (active.isContentEditable ||
          active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        active.blur()
      }
      setSelectedId((cur) => {
        if (cur == null) {
          // No selection yet — first press grabs the most recent message.
          return ordered[ordered.length - 1]!.id
        }
        const idx = ordered.findIndex((m) => m.id === cur)
        if (idx === -1) return ordered[ordered.length - 1]!.id
        const next = Math.max(0, Math.min(ordered.length - 1, idx + dir))
        return ordered[next]!.id
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ordered, selectedId, channelId])

  // Reset selection when the channel switches — the previous selection
  // doesn't refer to anything in the new view.
  useEffect(() => {
    setSelectedId(null)
  }, [channelId])

  // Scroll the selected message into view as the highlight moves. `nearest`
  // avoids a jolt when the selection is already on screen.
  useEffect(() => {
    if (!selectedId) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const node = scroller.querySelector<HTMLElement>(
      `[data-message-id="${selectedId}"]`,
    )
    if (node) node.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [selectedId])

  // ID of the current user's most recent message in the loaded set. Drives
  // edit-eligibility — only the user's last message is editable, matching the
  // server's NOT EXISTS guard in the EditMessage query.
  const myLatestMessageId = useMemo(() => {
    for (let i = ordered.length - 1; i >= 0; i--) {
      const m = ordered[i]
      if (m && m.user_id === currentUserID) return m.id
    }
    return null
  }, [ordered, currentUserID])

  // 'e' hotkey — enter edit mode on the selected message, but only when
  // (1) the selection IS the user's most recent message in this channel
  // (server rejects edits on older messages anyway), and (2) the user
  // isn't currently typing in an editable area. Encoded as
  // { id, n } so the targeted MessageItem can distinguish "a fresh
  // request landed on me" from "I just got selected and the request was
  // already non-null". A bare counter would fire spuriously each time
  // selection moved onto a different message.
  const [editRequest, setEditRequest] = useState<{ id: string; n: number } | null>(null)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'e' && e.key !== 'E') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!selectedId || selectedId !== myLatestMessageId) return
      // Bail if the user is mid-type — TipTap renders into a ProseMirror
      // contentEditable, so check both that and the boring form controls.
      const active = document.activeElement as HTMLElement | null
      if (active) {
        if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') return
        if (active.isContentEditable) return
      }
      e.preventDefault()
      setEditRequest((cur) => ({ id: selectedId, n: (cur?.n ?? 0) + 1 }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, myLatestMessageId])

  // 'p' hotkey — toggle pin on the selected message. Mutation fires
  // directly from the keydown handler; we deliberately don't relay through
  // a prop on MessageItem because props that flip when `selectedId` moves
  // would trip every newly-selected item's effect with the latest tick.
  // Pin permissions are channel-wide, so this isn't author-gated.
  const pinMut = usePinMessage(channelId)
  const unpinMut = useUnpinMessage(channelId)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'p' && e.key !== 'P') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!selectedId) return
      const active = document.activeElement as HTMLElement | null
      if (active) {
        if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') return
        if (active.isContentEditable) return
      }
      e.preventDefault()
      const target = ordered.find((m) => m.id === selectedId)
      if (!target) return
      if (target.pinned) {
        unpinMut.mutate({ messageId: target.id })
      } else {
        pinMut.mutate({ messageId: target.id, pinnedByUserId: currentUserID })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, ordered, currentUserID, pinMut, unpinMut])

  // ── scroll anchoring ─────────────────────────────────────────────────────
  const scrollerRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  // Track whether the user was pinned at the bottom *before* the latest update.
  // We only auto-scroll on new messages when this is true.
  const stickToBottomRef = useRef(true)
  // When loading older pages, the new content is prepended; preserve the
  // visual position by snapshotting scrollHeight - scrollTop, then restoring.
  const prependAnchorRef = useRef<number | null>(null)
  const lastTopMessageIdRef = useRef<string | null>(null)

  // Decide stickiness on each scroll event.
  function onScroll() {
    const el = scrollerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 80
  }

  // After every render: if we just prepended older messages, restore position;
  // else if user is sticky-at-bottom, scroll to bottom.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el || ordered.length === 0) return
    if (prependAnchorRef.current !== null) {
      // Restore scroll so the visual top stays anchored on the same message.
      el.scrollTop = el.scrollHeight - prependAnchorRef.current
      prependAnchorRef.current = null
      return
    }
    const topMessageId = ordered[0]?.id ?? null
    const isFirstRender = lastTopMessageIdRef.current === null
    lastTopMessageIdRef.current = topMessageId
    if (isFirstRender || stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [ordered])

  // Reset stickiness + anchor when the active channel changes — otherwise the
  // previous channel's "near bottom" state bleeds into the new one.
  useEffect(() => {
    stickToBottomRef.current = true
    lastTopMessageIdRef.current = null
    prependAnchorRef.current = null
  }, [channelId])

  // Scroll-to-target logic. When scrollTargetMessageId is set AND the target
  // is present in the loaded data, find it in the DOM, scroll into view,
  // highlight briefly, then clear the request via onScrollHandled.
  useLayoutEffect(() => {
    if (!scrollTargetMessageId) return
    if (!ordered.some((m) => m.id === scrollTargetMessageId)) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const node = scroller.querySelector<HTMLElement>(
      `[data-message-id="${scrollTargetMessageId}"]`,
    )
    if (!node) return
    // Disable sticky-to-bottom for this navigation; we're jumping somewhere
    // in the middle of history.
    stickToBottomRef.current = false
    node.scrollIntoView({ block: 'center', behavior: 'auto' })
    setHighlightId(scrollTargetMessageId)
    onScrollHandled()
  }, [ordered, scrollTargetMessageId, onScrollHandled])

  // Clear the highlight after a short flash.
  useEffect(() => {
    if (!highlightId) return
    const t = window.setTimeout(() => setHighlightId(null), 1800)
    return () => window.clearTimeout(t)
  }, [highlightId])

  // IntersectionObserver on a sentinel at the top kicks in fetchNextPage.
  useEffect(() => {
    const sentinel = topSentinelRef.current
    const scroller = scrollerRef.current
    if (!sentinel || !scroller || !hasNextPage) return
    const obs = new IntersectionObserver(
      (entries) => {
        const [entry] = entries
        if (entry?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          // Snapshot the offset from the bottom so useLayoutEffect can restore.
          prependAnchorRef.current = scroller.scrollHeight - scroller.scrollTop
          fetchNextPage()
        }
      },
      { root: scroller, rootMargin: '200px 0px 0px 0px' },
    )
    obs.observe(sentinel)
    return () => obs.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  if (isLoading) {
    return <div className="flex-1 px-4 py-3 text-sm text-zinc-500">Loading…</div>
  }
  if (error) {
    return (
      <div className="flex-1 px-4 py-3 text-sm text-rose-400">
        Error loading messages: {String(error)}
      </div>
    )
  }

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-4 py-3"
    >
      <div ref={topSentinelRef} />
      {hasNextPage && (
        <div className="text-center py-2 text-xs text-zinc-500">
          {isFetchingNextPage ? 'Loading older messages…' : 'Scroll up for more'}
        </div>
      )}
      {!hasNextPage && ordered.length > 0 && (
        <div className="text-center py-2 text-xs text-zinc-600">
          — beginning of channel —
        </div>
      )}
      {ordered.length === 0 && (
        <div className="text-sm text-zinc-500">No messages yet. Start the conversation.</div>
      )}
      <ul className="space-y-3">
        {ordered.map((m, i) => {
          const prev = i > 0 ? ordered[i - 1] : null
          const showDivider =
            !prev || !sameLocalDay(prev.created_at, m.created_at)
          return (
            <Fragment key={m.id}>
              {showDivider && <DayDivider iso={m.created_at} />}
              <MessageItem
                m={m}
                member={m.user_id ? memberMap.get(m.user_id) : undefined}
                memberMap={memberMap}
                currentUserID={currentUserID}
                channelId={channelId}
                highlighted={m.id === highlightId}
                selected={m.id === selectedId}
                isMyLatest={m.id === myLatestMessageId}
                onOpenThread={onOpenThread}
                onUserClick={onUserClick}
                editRequest={editRequest && editRequest.id === m.id ? editRequest : null}
              />
            </Fragment>
          )
        })}
      </ul>
    </div>
  )
}

// True when two ISO timestamps fall on the same calendar day in the user's
// local timezone. Used to group messages under day dividers; the wall-clock
// day is what a reader expects to see, not UTC midnight.
function sameLocalDay(aISO: string, bISO: string): boolean {
  const a = new Date(aISO)
  const b = new Date(bISO)
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameLocalDay(iso, now.toISOString())) return 'Today'
  if (sameLocalDay(iso, yesterday.toISOString())) return 'Yesterday'
  // Within the last week: just the weekday. Older: full date.
  const diffDays = Math.floor(
    (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24),
  )
  if (diffDays > 0 && diffDays < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'long' })
  }
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  })
}

// Day divider — Slack-style floating pill, centered, no through-line. A subtle
// hairline sits behind it so the eye still picks up the day break even when
// the pill itself blends in.
function DayDivider({ iso }: { iso: string }) {
  return (
    <li
      role="separator"
      aria-label={dayLabel(iso)}
      className="relative my-4 flex items-center justify-center"
    >
      <span className="absolute inset-x-0 top-1/2 border-t border-zinc-800" />
      <span className="relative z-10 inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-950 px-3 py-1 text-xs font-semibold text-zinc-300 shadow-sm">
        {dayLabel(iso)}
        <ChevronDown className="h-3 w-3 text-zinc-500" />
      </span>
    </li>
  )
}

// timeAgo — short, Slack-style relative timestamp ("just now", "5m ago",
// "2h ago", "3d ago"). Falls back to a date string past a week.
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 30) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Most-used emoji reactions. Click outside or escape closes the picker.
// Swap for emoji-mart later if the set feels limiting.
const QUICK_REACTIONS = ['👍', '❤️', '🎉', '😄', '😮', '😢', '🙏', '👀', '🔥']

function MessageItem({
  m,
  member,
  memberMap,
  currentUserID,
  channelId,
  highlighted = false,
  selected = false,
  isMyLatest = false,
  onOpenThread,
  onUserClick,
  editRequest = null,
}: {
  m: Message
  member?: Member
  // Lookup of all channel members so the "pinned by {name}" badge can
  // resolve the pinner's display name. Optional — falls back to a short id
  // when absent.
  memberMap?: Map<string, Member>
  currentUserID: string
  channelId: string
  // Transient flash after a search-jump or anchor scroll.
  highlighted?: boolean
  // Persistent state from keyboard navigation. Distinct visual.
  selected?: boolean
  isMyLatest?: boolean
  onOpenThread?: (rootId: string) => void
  // Fires when the avatar or author name is clicked. Parent opens the user
  // info panel in the right sidebar.
  onUserClick?: (userId: string) => void
  // Targeted edit request from MessageList. Only set when the user pressed
  // 'e' AND this item is the intended target — `id` always matches `m.id`
  // when non-null, and `n` increments per press so consecutive 'e' presses
  // on the same message re-trigger the effect.
  editRequest?: { id: string; n: number } | null
}) {
  const author = member?.display_name ?? '(unknown user)'
  // Slack-style "10:04 AM" — drop seconds.
  const ts = new Date(m.created_at).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  const isOwn = m.user_id === currentUserID
  const [editing, setEditing] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const editMut = useEditMessage(channelId)
  const delMut = useDeleteMessage(channelId)
  const reactMut = useToggleReaction(channelId, currentUserID)
  const pinMut = usePinMessage(channelId)
  const unpinMut = useUnpinMessage(channelId)

  // Honor 'e' hotkey requests from MessageList. The parent only sets
  // editRequest on the targeted message, but a freshly-selected item still
  // sees the prop transition `null → {id, n}`, which would otherwise fire
  // the effect even when the user didn't press 'e'. Track the last `n` we
  // acted on and ignore everything else.
  const lastEditNRef = useRef<number | null>(null)
  useEffect(() => {
    if (!editRequest) {
      lastEditNRef.current = null
      return
    }
    if (lastEditNRef.current === editRequest.n) return
    lastEditNRef.current = editRequest.n
    // Defensive — parent gates on ownership + isMyLatest already.
    if (!isOwn || !isMyLatest) return
    setEditing(true)
  }, [editRequest, isOwn, isMyLatest])

  function handleDelete() {
    if (!confirm('Delete this message?')) return
    delMut.mutate(m.id)
  }

  function handleReact(emoji: string) {
    const already = !!m.reactions?.find(
      (r) => r.emoji === emoji && r.user_ids.includes(currentUserID),
    )
    reactMut.mutate({ messageId: m.id, emoji, alreadyReacted: already })
    setPickerOpen(false)
  }

  // "Mentions me" check — true when the message has a mention notification
  // targeting the current user, *or* a channel-wide kind (which fans out
  // to me too). The visual cue is a left edge accent, applied only when
  // not already highlighted/selected so we don't stack rings.
  const mentionsMe = (m.mentions ?? []).some((mn) =>
    mn.kind === 'user' ? mn.user_id === currentUserID : true,
  )
  return (
    <li
      data-message-id={m.id}
      className={
        'message-row group relative -mx-2 flex gap-3 rounded px-2 py-1 transition-colors duration-700 hover:bg-zinc-900/40 ' +
        (isOwn ? 'flex-row-reverse ' : '') +
        (highlighted
          ? 'bg-amber-500/10 ring-1 ring-amber-500/40'
          : selected
            ? 'bg-sky-500/10 ring-1 ring-sky-500/40'
            : mentionsMe
              ? 'bg-amber-500/[0.04] border-l-2 border-amber-500/60 pl-1.5'
              : '')
      }
    >
      {onUserClick && m.user_id ? (
        <button
          type="button"
          onClick={() => onUserClick(m.user_id!)}
          title={`Open user info — ${author}`}
          className="flex start mt-0.5 shrink-0 rounded-md hover:opacity-80"
        >
          <Avatar src={member?.avatar_url} name={author} size={36} />
        </button>
      ) : (
        <Avatar
          src={member?.avatar_url}
          name={author}
          size={36}
          className="mt-0.5 shrink-0"
        />
      )}
      <div className={'min-w-0 flex-1 ' + (isOwn ? 'text-right' : '')}>
      <div className={'flex items-baseline gap-2 ' + (isOwn ? 'flex-row-reverse' : '')}>
        {onUserClick && m.user_id ? (
          <button
            type="button"
            onClick={() => onUserClick(m.user_id!)}
            title={`Open user info — ${author}`}
            className="font-bold text-zinc-100 hover:underline"
          >
            {author}
          </button>
        ) : (
          <span className="font-bold text-zinc-100">{author}</span>
        )}
        <span className="text-xs text-zinc-500">{ts}</span>
        {m.edited_at && <span className="text-xs text-zinc-600">(edited)</span>}
      </div>

      {editing ? (
        <InlineEditor
          initialText={m.text}
          initialPayload={m.payload as import('@tiptap/react').JSONContent | undefined}
          onCancel={() => setEditing(false)}
          onSave={(text, payload) => {
            editMut.mutate(
              { messageId: m.id, text, payload },
              { onSuccess: () => setEditing(false) },
            )
          }}
          pending={editMut.isPending}
        />
      ) : isTranscriptPayload(m.payload) ? (
        // Server-authored transcript-ready message. Custom card with a
        // "View" button that pops the segments dialog. We deliberately
        // suppress the message's text body — the card subsumes it.
        <TranscriptCard payload={m.payload} members={memberMap} />
      ) : m.payload ? (
        <div className="break-words">
          <MessageRender doc={m.payload as import('@tiptap/react').JSONContent} />
        </div>
      ) : m.text ? (
        <p className="whitespace-pre-wrap break-words">{m.text}</p>
      ) : null}

      {m.attachments && m.attachments.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {m.attachments.map((a) => (
            <AttachmentView key={a.id} a={a} />
          ))}
        </ul>
      )}

      {m.reactions && m.reactions.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1">
          {m.reactions.map((r) => {
            // user_ids comes back null when the Go aggregate-to-strings
            // helper doesn't recognize the underlying pg type. Defend with
            // an empty array so the row still renders.
            const userIDs = r.user_ids ?? []
            const mine = userIDs.includes(currentUserID)
            return (
              <li key={r.emoji}>
                <button
                  onClick={() => handleReact(r.emoji)}
                  title={userIDs
                    .map((uid) => uid === currentUserID ? 'you' : uid.slice(0, 8))
                    .join(', ')}
                  className={
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ' +
                    (mine
                      ? 'border-sky-500/60 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800')
                  }
                >
                  <span>{r.emoji}</span>
                  <span className="tabular-nums">{r.count}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* Pinned badge — small "Pinned by Alice" line under the body. The
          channel header's Pin icon opens the full Pinned panel. */}
      {m.pinned && (
        <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-amber-400/80">
          <Pin className="h-3 w-3" />
          <span>
            Pinned
            {m.pinned_by_user_id && (
              <>
                {' by '}
                <span className="font-medium">
                  {memberMap?.get(m.pinned_by_user_id)?.display_name ??
                    (m.pinned_by_user_id === currentUserID
                      ? 'you'
                      : m.pinned_by_user_id.slice(0, 8))}
                </span>
              </>
            )}
          </span>
        </div>
      )}

      {/* Thread reply summary — only on root messages with replies. */}
      {!m.thread_root_id && (m.reply_count ?? 0) > 0 && onOpenThread && (
        <button
          type="button"
          onClick={() => onOpenThread(m.id)}
          className="mt-1.5 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-sky-400 hover:bg-zinc-800/60"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          <span>{m.reply_count} {m.reply_count === 1 ? 'reply' : 'replies'}</span>
          {m.last_reply_at && (
            <span className="font-normal text-zinc-500">
              Last reply {timeAgo(m.last_reply_at)}
            </span>
          )}
        </button>
      )}

      {/* hover toolbar — top-right of the row */}
      {!editing && (
        <div className="absolute -top-3 right-2 flex items-center rounded border border-zinc-700 bg-zinc-900 opacity-0 shadow-md transition-opacity group-hover:opacity-100">
          <div className="relative">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              title="Add reaction"
              className="flex h-7 w-7 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <SmilePlus className="h-4 w-4" />
            </button>
            {pickerOpen && (
              <EmojiPickerPopover
                onPick={handleReact}
                onClose={() => setPickerOpen(false)}
              />
            )}
          </div>
          {onOpenThread && !m.thread_root_id && (
            <button
              type="button"
              onClick={() => onOpenThread(m.id)}
              title="Reply in thread"
              className="flex h-7 w-7 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <MessageSquare className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (m.pinned) {
                unpinMut.mutate({ messageId: m.id })
              } else {
                pinMut.mutate({ messageId: m.id, pinnedByUserId: currentUserID })
              }
            }}
            title={m.pinned ? 'Unpin from channel (p)' : 'Pin to channel (p)'}
            className={
              'flex h-7 w-7 items-center justify-center hover:bg-zinc-800 ' +
              (m.pinned
                ? 'text-amber-400 hover:text-amber-300'
                : 'text-zinc-400 hover:text-zinc-100')
            }
          >
            {m.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
          {isOwn && (
            <>
              {isMyLatest && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  title="Edit"
                  className="flex h-7 w-7 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={handleDelete}
                title="Delete"
                className="flex h-7 w-7 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-rose-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      )}
      </div>
    </li>
  )
}

// ThreadView — the *body* portion of a thread (no aside chrome, no header).
// The surrounding aside + close button live in <RightSidebar>; this component
// just fills the slot the sidebar context hands it.
function ThreadView({
  rootId,
  channelId,
  workspaceSlug,
  memberMap,
  currentUserID,
  onUserClick,
}: {
  rootId: string
  channelId: string
  // Needed so the embedded Composer can presign attachment uploads — uploads
  // are workspace-scoped, not channel-scoped.
  workspaceSlug: string
  memberMap: Map<string, Member>
  currentUserID: string
  onUserClick?: (userId: string) => void
}) {
  const { data, isLoading, error } = useThreadReplies(rootId)
  const scrollerRef = useRef<HTMLDivElement>(null)

  // Stick to bottom on each new reply — threads read top-down chronologically.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [data?.replies.length])

  // Look up the parent message in the channel cache to render it inline at
  // the top of the panel. Falls back to a "loading" line if the channel
  // timeline page that contained it hasn't been fetched.
  const qc = useQueryClient()
  const parent = useMemo<Message | undefined>(() => {
    const all = qc.getQueriesData<MessagesInfiniteData>({
      queryKey: ['messages', channelId],
      exact: false,
    })
    for (const [, infinite] of all) {
      if (!infinite) continue
      for (const page of infinite.pages) {
        const found = page.messages.find((m) => m.id === rootId)
        if (found) return found
      }
    }
    return undefined
  }, [qc, channelId, rootId, data])

  return (
    <div className="flex h-full flex-col min-h-0">
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-3 py-3 min-h-0">
        {parent && (
          <div className="border-b border-zinc-800 pb-3 mb-3">
            <ul>
              <MessageItem
                m={parent}
                member={parent.user_id ? memberMap.get(parent.user_id) : undefined}
                currentUserID={currentUserID}
                channelId={channelId}
                onUserClick={onUserClick}
              />
            </ul>
          </div>
        )}

        {data && (
          <p className="px-1 pb-2 text-xs text-zinc-500">
            {data.reply_count} {data.reply_count === 1 ? 'reply' : 'replies'}
          </p>
        )}

        {isLoading && (
          <div className="text-sm text-zinc-500">Loading replies…</div>
        )}
        {error && (
          <div className="text-sm text-rose-400">
            Error loading thread: {String(error)}
          </div>
        )}
        {data && data.replies.length === 0 && (
          <div className="text-xs text-zinc-500">No replies yet — be the first.</div>
        )}
        {data && data.replies.length > 0 && (
          <ul className="space-y-3">
            {data.replies.map((r) => (
              <MessageItem
                key={r.id}
                m={r}
                member={r.user_id ? memberMap.get(r.user_id) : undefined}
                currentUserID={currentUserID}
                channelId={channelId}
                onUserClick={onUserClick}
              />
            ))}
          </ul>
        )}
      </div>

      <Composer
        channelId={channelId}
        workspaceSlug={workspaceSlug}
        archived={false}
        currentUserID={currentUserID}
        mode="thread"
        threadRootId={rootId}
      />
    </div>
  )
}

function EmojiPickerPopover({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void
  onClose: () => void
}) {
  // Close on outside click + escape.
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div
      ref={ref}
      className="absolute right-0 top-8 z-10 flex flex-wrap gap-1 rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl"
      style={{ width: '13rem' }}
    >
      {QUICK_REACTIONS.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onPick(e)}
          className="flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-zinc-800"
        >
          {e}
        </button>
      ))}
    </div>
  )
}

function InlineEditor({
  initialText,
  initialPayload,
  onCancel,
  onSave,
  pending,
}: {
  initialText: string
  initialPayload?: import('@tiptap/react').JSONContent
  onCancel: () => void
  onSave: (text: string, payload?: unknown) => void
  pending: boolean
}) {
  // Stash refs for the editor + the latest save() so the editor's onSubmit
  // (Enter handler) can fire the current closure.
  const saveRef = useRef<() => void>(() => {})
  const editor = useChatEditor({
    placeholder: 'Edit message…',
    onSubmit() {
      saveRef.current()
    },
  })
  // Seed the editor with the message's existing content the first time it
  // mounts. We don't pass `content` to useChatEditor because it doesn't take
  // it; commands.setContent works on first non-null editor render.
  const seededRef = useRef(false)
  useEffect(() => {
    if (!editor || seededRef.current) return
    seededRef.current = true
    if (initialPayload) {
      editor.commands.setContent(initialPayload)
    } else if (initialText) {
      editor.commands.setContent(initialText)
    }
    editor.commands.focus('end')
  }, [editor, initialPayload, initialText])

  function save() {
    if (!editor) return
    const text = editor.getText().trim()
    const json = editor.getJSON()
    const richEmpty = docIsEmpty(json)
    if (!text && richEmpty) return
    onSave(text, !richEmpty ? json : undefined)
  }
  saveRef.current = save

  return (
    <div
      className="mt-1 rounded border border-zinc-700 bg-zinc-900/40"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    >
      <EditorView editor={editor} />
      <div className="flex items-center gap-2 border-t border-zinc-800 px-2 py-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <span className="ml-auto text-[11px] text-zinc-500">
          Enter to save · Shift+Enter for newline · Esc to cancel
        </span>
      </div>
    </div>
  )
}

function AttachmentView({ a }: { a: AttachmentFile }) {
  const isImage = a.mime_type.startsWith('image/') && a.url
  if (isImage) {
    // Cap visible size while preserving aspect ratio. Click opens full-size in a new tab.
    return (
      <li>
        <a href={a.url} target="_blank" rel="noopener noreferrer">
          <img
            src={a.url}
            alt={a.filename}
            width={a.image_width}
            height={a.image_height}
            className="max-h-80 max-w-md rounded border border-zinc-800 object-contain bg-zinc-950"
            loading="lazy"
          />
        </a>
      </li>
    )
  }
  return (
    <li>
      <a
        href={a.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
      >
        <Paperclip className="h-5 w-5 text-zinc-400" />
        <span className="flex flex-col min-w-0">
          <span className="truncate font-medium">{a.filename}</span>
          <span className="text-xs text-zinc-500">{human(a.bytes)} · {a.mime_type}</span>
        </span>
      </a>
    </li>
  )
}

// Local-only attachment slot before the file is finalized server-side.
type PendingAttachment = {
  localId: string
  file: File
  previewURL?: string
  status: 'queued' | 'uploading' | 'ready' | 'error'
  progress: number // 0..1
  finalized?: AttachmentFile
  error?: string
}

const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_PER_MESSAGE = 10

// MentionCandidate is one row in the @-typeahead dropdown. Users are real
// members; specials are @channel / @here / @everyone, rendered as virtual
// rows below the user list. Unified type makes the picker uniform.
type MentionCandidate =
  | { kind: 'user'; userId: string; displayName: string; member: Member }
  | { kind: MentionKind; userId?: never; displayName: string; member?: never }

function Composer({
  channelId,
  workspaceSlug,
  archived,
  currentUserID,
  mode = 'channel',
  threadRootId,
}: {
  channelId: string
  workspaceSlug: string
  archived: boolean
  // Needed so a slash-command handler can identify the invoker. Could be
  // derived from useMe() in-place, but threading it makes the dependency
  // explicit and saves a render.
  currentUserID: string
  // 'channel' posts to the channel timeline (default).
  // 'thread' posts as a reply to `threadRootId`. Typing indicators are
  // suppressed in thread mode (threads don't surface them).
  mode?: 'channel' | 'thread'
  threadRootId?: string
}) {
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [hasContent, setHasContent] = useState(false)
  // Slash typeahead state — driven by the current editor text. When the
  // user types `/` as the first non-whitespace character, we show matching
  // commands; selecting one expands it back into the editor.
  const [slashMatches, setSlashMatches] = useState<SlashCommand[]>([])
  const [slashHighlight, setSlashHighlight] = useState(0)
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  // Tracks whether the most recent submit was a slash command we already
  // ran — used to suppress the trailing "Couldn't post: ..." toast that
  // would otherwise fire if the handler returned a no-op (null) result.
  const slashHandlingRef = useRef(false)
  // Mention typeahead state. `mentionQuery` is the partial after the `@`
  // (e.g. "bo" for "@bo"); null means the dropdown is hidden. `mentionFrom`
  // / `mentionTo` mark the position range in the editor doc that should be
  // replaced when the user picks a candidate.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionFrom, setMentionFrom] = useState(0)
  const [mentionTo, setMentionTo] = useState(0)
  const [mentionHighlight, setMentionHighlight] = useState(0)
  // Giphy pre-send picker. When set, the composer is in preview mode: the
  // user is choosing a gif (Next / Send / Cancel) instead of typing. We
  // gate the normal send path so Enter in the editor doesn't fire while
  // the picker is up.
  const [giphyPicker, setGiphyPicker] = useState<{ query: string } | null>(null)
  const { data: members } = useMembers(workspaceSlug)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Both mutations are always declared so React hook order stays stable; only
  // the one matching `mode` is invoked by send().
  const postChannel = usePostMessage(channelId)
  const postThread = usePostThreadReply(threadRootId ?? null, channelId)
  const post = mode === 'thread' ? postThread : postChannel
  // Typing notifier is a no-op when channelId is null; pass null in thread
  // mode so we don't broadcast typing into the channel surface.
  const typing = useTypingNotifier(mode === 'thread' ? null : channelId)

  // Bookkeeping refs let send/onUpdate read state without re-creating the editor.
  const editorRef = useRef<Editor | null>(null)
  const sendRef = useRef<() => void>(() => {})

  const editor = useChatEditor({
    placeholder: archived
      ? 'Channel is archived'
      : mode === 'thread'
        ? 'Reply…'
        : 'Message…',
    disabled: archived,
    onUpdate(e) {
      const empty = docIsEmpty(e.getJSON())
      setHasContent(!empty)
      if (!empty) typing.notify()
      else typing.stop()
      // Slash-command typeahead. Show matches while the user is still on
      // the command name (`/gi` → giphy, gif, ...). Once whitespace follows
      // the name we assume they're typing args and dismiss the dropdown.
      const text = e.getText()
      const trimmedStart = text.trimStart()
      if (trimmedStart.startsWith('/') && !trimmedStart.slice(1).includes(' ')) {
        const partial = trimmedStart.slice(1).toLowerCase()
        const all = listSlashCommands()
        const matches = partial
          ? all.filter((c) => c.name.startsWith(partial))
          : all
        setSlashQuery(partial)
        setSlashMatches(matches)
        setSlashHighlight(0)
      } else if (slashQuery !== null) {
        setSlashQuery(null)
        setSlashMatches([])
      }
      // @-mention typeahead. We look backward from the cursor for the
      // nearest `@`; if it's preceded by whitespace (or start-of-doc) and
      // has no whitespace between it and the cursor, that's a live
      // @-token. Detection runs over plain text — TipTap mark detection
      // would also catch *resolved* mentions, but we only want to show
      // the dropdown while the user is still typing the partial.
      const { from } = e.state.selection
      const before = e.state.doc.textBetween(0, from, '\n', '\n')
      const atIdx = before.lastIndexOf('@')
      let inMention = false
      if (atIdx !== -1) {
        const between = before.slice(atIdx + 1)
        const prevCh = atIdx === 0 ? '' : before[atIdx - 1]
        const validStart = atIdx === 0 || /\s/.test(prevCh ?? '')
        if (validStart && !/\s/.test(between)) {
          // ProseMirror positions are 1-based for the doc start. textBetween
          // counts characters with newlines collapsed; for replace we need
          // the doc position of the `@`, which equals atIdx + 1 (skip the
          // leading doc node) on a single-paragraph message. Hard-breaks
          // would skew this — accepted limitation for v1.
          setMentionQuery(between)
          setMentionFrom(atIdx + 1)
          setMentionTo(from)
          setMentionHighlight(0)
          inMention = true
        }
      }
      if (!inMention && mentionQuery !== null) {
        setMentionQuery(null)
      }
    },
    onSubmit() {
      sendRef.current()
    },
  })
  editorRef.current = editor

  // MessageList fires `stack:focus-composer` when the user ArrowDowns past
  // the most recent message — yield focus back to the composer.
  useEffect(() => {
    function onFocus(e: Event) {
      const ev = e as CustomEvent<{ channelId: string; mode: 'channel' | 'thread' }>
      if (!ev.detail) return
      if (ev.detail.channelId !== channelId) return
      if (ev.detail.mode !== mode) return
      editorRef.current?.commands.focus()
    }
    window.addEventListener('stack:focus-composer', onFocus)
    return () => window.removeEventListener('stack:focus-composer', onFocus)
  }, [channelId, mode])

  // Whatever's mounted gets its preview URLs revoked on unmount.
  useEffect(
    () => () => {
      pending.forEach((p) => {
        if (p.previewURL) URL.revokeObjectURL(p.previewURL)
      })
    },
    // intentionally only on unmount; do not retrigger when pending changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  function addFiles(files: File[]) {
    if (archived) return
    if (files.length === 0) return
    const room = MAX_PER_MESSAGE - pending.length
    const accepted = files.slice(0, room)
    const next: PendingAttachment[] = accepted.map((f, i) => {
      const localId = `${Date.now()}-${i}-${f.name}`
      const isImg = f.type.startsWith('image/')
      const oversized = f.size > MAX_FILE_BYTES
      return {
        localId,
        file: f,
        previewURL: isImg ? URL.createObjectURL(f) : undefined,
        status: oversized ? 'error' : 'queued',
        progress: 0,
        error: oversized ? `Too large (${human(f.size)})` : undefined,
      }
    })
    setPending((cur) => [...cur, ...next])
    // Kick uploads for the queued ones.
    next.forEach((slot) => {
      if (slot.status === 'queued') {
        void runUpload(slot.localId, slot.file)
      }
    })
  }

  async function runUpload(localId: string, file: File) {
    setPending((cur) =>
      cur.map((p) => (p.localId === localId ? { ...p, status: 'uploading' } : p)),
    )
    try {
      const finalized = await uploadAttachment(workspaceSlug, file, (frac) => {
        setPending((cur) =>
          cur.map((p) => (p.localId === localId ? { ...p, progress: frac } : p)),
        )
      })
      setPending((cur) =>
        cur.map((p) =>
          p.localId === localId ? { ...p, status: 'ready', finalized, progress: 1 } : p,
        ),
      )
    } catch (err) {
      setPending((cur) =>
        cur.map((p) =>
          p.localId === localId ? { ...p, status: 'error', error: String(err) } : p,
        ),
      )
    }
  }

  function removeAttachment(localId: string) {
    setPending((cur) => {
      const target = cur.find((p) => p.localId === localId)
      if (target?.previewURL) URL.revokeObjectURL(target.previewURL)
      return cur.filter((p) => p.localId !== localId)
    })
  }

  function resetAfterSend() {
    const e = editorRef.current
    e?.commands.clearContent()
    setHasContent(false)
    setSlashQuery(null)
    setSlashMatches([])
    setMentionQuery(null)
    setGiphyPicker(null)
    pending.forEach((p) => {
      if (p.previewURL) URL.revokeObjectURL(p.previewURL)
    })
    setPending([])
  }

  async function send() {
    const e = editorRef.current
    const trimmed = e ? e.getText().trim() : ''
    const json = e ? e.getJSON() : undefined
    const richEmpty = docIsEmpty(json)
    const ready = pending.filter((p) => p.status === 'ready' && p.finalized)
    const stillUploading = pending.some((p) => p.status === 'uploading' || p.status === 'queued')
    if (stillUploading) return

    // Slash-command interception. Look up the handler from the plain-text
    // form (formatting marks would survive in the JSON; the canonical input
    // is the user-visible text). When a handler matches we run it and feed
    // its returned message body into the same post.mutate path that hand-
    // typed messages use — so plugins ride the same validation, optimistic
    // update, and realtime echo as user posts. Unknown commands fall through
    // and post as raw text (more useful than a silent "command not found").
    const slash = parseSlashInput(trimmed)
    if (slash) {
      // Giphy gets a Composer-internal hard-code: open the pre-send picker
      // instead of running the registered handler. The slash command is
      // still registered (for typeahead discovery) but its run() never
      // fires from this path. Empty query → silently bail; nothing to
      // search for.
      if (slash.name === 'giphy') {
        if (!slash.args) return
        setGiphyPicker({ query: slash.args })
        return
      }
      const cmd = getSlashCommand(slash.name)
      if (cmd) {
        if (slashHandlingRef.current) return
        slashHandlingRef.current = true
        try {
          const ctx: SlashCommandContext = {
            channelId,
            workspaceSlug,
            currentUserID,
            isThread: mode === 'thread',
          }
          const result = await cmd.run(slash.args, ctx)
          if (!result) {
            resetAfterSend()
            return
          }
          const text = (result.text ?? '').trim()
          const fileIDsFromPlugin = result.file_ids ?? []
          const allFileIDs = [
            ...ready.map((p) => p.finalized!.id),
            ...fileIDsFromPlugin,
          ]
          if (!text && !result.payload && allFileIDs.length === 0) {
            resetAfterSend()
            return
          }
          typing.stop()
          // Slash-command results can carry their own structural mentions
          // (eg. a future /announce plugin). Extract from the returned
          // payload so plugins don't have to manually thread the mentions
          // array through their result type.
          const pluginMentions = result.payload
            ? extractMentionsFromDoc(result.payload as Parameters<typeof extractMentionsFromDoc>[0])
            : []
          post.mutate(
            {
              text,
              payload: result.payload,
              file_ids: allFileIDs.length > 0 ? allFileIDs : undefined,
              mentions: pluginMentions.length > 0 ? pluginMentions : undefined,
            },
            { onSuccess: () => resetAfterSend() },
          )
        } catch (err) {
          console.error(`slash command /${cmd.name} failed:`, err)
        } finally {
          slashHandlingRef.current = false
        }
        return
      }
    }

    if (!trimmed && ready.length === 0) return
    const fileIDs = ready.map((p) => p.finalized!.id)
    typing.stop()
    // Extract structural mentions from the TipTap doc — these come from
    // the mention marks the @-typeahead inserted. Literal "@bob" text
    // typed without picking from the dropdown carries no mark and so
    // produces no notification (matches Slack's "you have to actually
    // select the mention" UX).
    const mentions = extractMentionsFromDoc(json)
    post.mutate(
      {
        text: trimmed,
        // Only send payload when there's actually rich structure to preserve.
        // A bare paragraph round-trips fine via plain text alone.
        payload: !richEmpty ? json : undefined,
        file_ids: fileIDs.length > 0 ? fileIDs : undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
      },
      { onSuccess: () => resetAfterSend() },
    )
  }
  sendRef.current = () => {
    void send()
  }

  // Drag-drop on the composer card.
  function onDragOver(e: React.DragEvent) {
    if (archived) return
    e.preventDefault()
    setDragActive(true)
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setDragActive(false)
  }
  function onDrop(e: React.DragEvent) {
    if (archived) return
    e.preventDefault()
    setDragActive(false)
    const dropped = Array.from(e.dataTransfer.files)
    addFiles(dropped)
  }

  // Paste images / files from clipboard.
  function onPaste(e: React.ClipboardEvent) {
    if (archived) return
    const items = Array.from(e.clipboardData.items)
    const files = items
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }

  const stillUploading = pending.some((p) => p.status === 'uploading' || p.status === 'queued')
  const canSend = !post.isPending && !stillUploading && (
    hasContent || pending.some((p) => p.status === 'ready')
  )
  const [showFormatBar, setShowFormatBar] = useState(true)

  // Stub callback used by every not-yet-implemented icon (emoji, mentions,
  // video/audio, slash commands). Easier to swap in real handlers later than
  // to wire onClick={undefined} everywhere.
  const stub = () => {}

  // ── editor command helpers — keep .focus() before each chain so the
  // ── selection survives a click on the toolbar.
  const cmd = {
    bold:        () => editor?.chain().focus().toggleBold().run(),
    italic:      () => editor?.chain().focus().toggleItalic().run(),
    underline:   () => editor?.chain().focus().toggleUnderline().run(),
    strike:      () => editor?.chain().focus().toggleStrike().run(),
    olist:       () => editor?.chain().focus().toggleOrderedList().run(),
    ulist:       () => editor?.chain().focus().toggleBulletList().run(),
    quote:       () => editor?.chain().focus().toggleBlockquote().run(),
    code:        () => editor?.chain().focus().toggleCode().run(),
    codeBlock:   () => editor?.chain().focus().toggleCodeBlock().run(),
    link: () => {
      if (!editor) return
      const prev = editor.getAttributes('link').href as string | undefined
      const url = window.prompt('Link URL', prev ?? 'https://')
      if (url === null) return
      if (url === '') {
        editor.chain().focus().extendMarkRange('link').unsetLink().run()
        return
      }
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    },
  }
  const isActive = (mark: string, attrs?: Record<string, unknown>) =>
    !!editor?.isActive(mark, attrs)

  function pickSlash(name: string) {
    const e = editorRef.current
    if (!e) return
    // Wipe whatever the user has typed and prefill `/<name> ` so the editor
    // sits at the args position. Keeps the typing → Enter flow consistent
    // regardless of whether the user clicked or typed the full name.
    e.commands.clearContent()
    e.commands.insertContent(`/${name} `)
    e.commands.focus()
    setSlashQuery(null)
    setSlashMatches([])
  }

  // mentionCandidates joins live channel/workspace members with the three
  // special kinds. Filtered to whatever the user has typed so far.
  const mentionCandidates: MentionCandidate[] = useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    const memberRows: MentionCandidate[] = (members ?? [])
      .filter((m) => m.user_id !== currentUserID)
      .filter((m) => {
        if (!q) return true
        return (
          m.display_name.toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q)
        )
      })
      .slice(0, 8)
      .map((m) => ({
        kind: 'user' as const,
        userId: m.user_id,
        displayName: m.display_name,
        member: m,
      }))
    const specials: MentionCandidate[] = (
      [
        { kind: 'channel' as MentionKind, displayName: 'channel' },
        { kind: 'here' as MentionKind, displayName: 'here' },
        { kind: 'everyone' as MentionKind, displayName: 'everyone' },
      ] as MentionCandidate[]
    ).filter((s) => !q || s.displayName.startsWith(q))
    return [...memberRows, ...specials]
  }, [members, mentionQuery, currentUserID])

  function pickMention(c: MentionCandidate) {
    const e = editorRef.current
    if (!e) return
    const label = c.displayName
    e.chain()
      .focus()
      .deleteRange({ from: mentionFrom, to: mentionTo })
      .insertContent([
        {
          type: 'text',
          text: `@${label}`,
          marks: [
            {
              type: 'mention',
              attrs: {
                userId: c.kind === 'user' ? c.userId : null,
                kind: c.kind,
                label,
              },
            },
          ],
        },
        { type: 'text', text: ' ' },
      ])
      .run()
    setMentionQuery(null)
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative border-t border-zinc-800 p-3"
    >
      {slashQuery !== null && slashMatches.length > 0 && (
        <SlashTypeahead
          matches={slashMatches}
          highlight={slashHighlight}
          onPick={pickSlash}
          onHoverIndex={setSlashHighlight}
        />
      )}
      {mentionQuery !== null && mentionCandidates.length > 0 && (
        <MentionTypeahead
          candidates={mentionCandidates}
          highlight={mentionHighlight}
          onPick={pickMention}
          onHoverIndex={setMentionHighlight}
        />
      )}
      {giphyPicker && (
        <GiphyPicker
          query={giphyPicker.query}
          onCancel={() => setGiphyPicker(null)}
          onSend={(result) => {
            typing.stop()
            post.mutate(
              { text: result.text, payload: result.payload },
              { onSuccess: () => resetAfterSend() },
            )
          }}
        />
      )}
      <div
        className={
          'rounded-lg bg-zinc-900/40 ' +
          (dragActive ? 'ring-2 ring-zinc-400' : '')
        }
      >
        {/* ── formatting toolbar ─────────────────────────────────────────── */}
        {showFormatBar && (
          <div className="flex items-center gap-0.5 border-b border-zinc-800 px-2 py-1.5">
            <ToolbarBtn title="Bold (⌘B)" onClick={cmd.bold} active={isActive('bold')}><Bold className="h-4 w-4" /></ToolbarBtn>
            <ToolbarBtn title="Italic (⌘I)" onClick={cmd.italic} active={isActive('italic')}><Italic className="h-4 w-4" /></ToolbarBtn>
            <ToolbarBtn title="Underline (⌘U)" onClick={cmd.underline} active={isActive('underline')}><Underline className="h-4 w-4" /></ToolbarBtn>
            <ToolbarBtn title="Strikethrough (⌘⇧X)" onClick={cmd.strike} active={isActive('strike')}><Strikethrough className="h-4 w-4" /></ToolbarBtn>
            <ToolbarSep />
            <ToolbarBtn title="Link (⌘K)" onClick={cmd.link} active={isActive('link')}><LinkIcon className="h-4 w-4" /></ToolbarBtn>
            <ToolbarBtn title="Numbered list" onClick={cmd.olist} active={isActive('orderedList')}><ListOrdered className="h-4 w-4" /></ToolbarBtn>
            <ToolbarBtn title="Bulleted list" onClick={cmd.ulist} active={isActive('bulletList')}><List className="h-4 w-4" /></ToolbarBtn>
            <ToolbarSep />
            <ToolbarBtn title="Blockquote" onClick={cmd.quote} active={isActive('blockquote')}><Quote className="h-4 w-4" /></ToolbarBtn>
            <ToolbarBtn title="Inline code" onClick={cmd.code} active={isActive('code')}><Code className="h-4 w-4" /></ToolbarBtn>
            <ToolbarBtn title="Code block" onClick={cmd.codeBlock} active={isActive('codeBlock')}><FileCode className="h-4 w-4" /></ToolbarBtn>
          </div>
        )}

        {/* ── pending attachments (preview + progress) ──────────────────── */}
        {pending.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-3 pt-2">
            {pending.map((p) => (
              <PendingAttachmentChip
                key={p.localId}
                p={p}
                onRemove={() => removeAttachment(p.localId)}
              />
            ))}
          </ul>
        )}

        {/* ── textarea ──────────────────────────────────────────────────── */}
        {/* TipTap handles keystrokes (incl. Enter→send via onSubmit) and
             paste of formatted text. We still listen for file pastes here
             so dropping an image into the editor flows into the upload pipe. */}
        <div
          onPaste={onPaste}
          onBlur={() => typing.stop()}
          className="pl-4 pr-3 pt-2.5 pb-2.5"
        >
          <EditorView editor={editor} />
        </div>

        {/* ── action bar ───────────────────────────────────────────────── */}
        <div className="flex items-center gap-0.5 border-t border-zinc-800 px-2 py-1.5">
          <ToolbarBtn
            title={archived ? 'Channel is archived' : 'Attach a file'}
            onClick={() => fileInputRef.current?.click()}
            disabled={archived || pending.length >= MAX_PER_MESSAGE}
          >
            <Plus className="h-4 w-4" />
          </ToolbarBtn>
          <ToolbarBtn
            title={showFormatBar ? 'Hide formatting' : 'Show formatting'}
            onClick={() => setShowFormatBar((v) => !v)}
            active={showFormatBar}
          >
            <ALargeSmall className="h-4 w-4" />
          </ToolbarBtn>
          <ToolbarBtn title="Emoji" onClick={stub}><Smile className="h-4 w-4" /></ToolbarBtn>
          <ToolbarBtn title="Mention someone" onClick={stub}><AtSign className="h-4 w-4" /></ToolbarBtn>
          <ToolbarSep />
          <ToolbarBtn title="Record video clip" onClick={stub}><Video className="h-4 w-4" /></ToolbarBtn>
          <ToolbarBtn title="Record audio clip" onClick={stub}><Mic className="h-4 w-4" /></ToolbarBtn>
          <ToolbarSep />
          <ToolbarBtn title="Slash command" onClick={stub}><Slash className="h-4 w-4" /></ToolbarBtn>

          <div className="ml-auto flex items-center">
            <button
              type="submit"
              disabled={!canSend}
              title={stillUploading ? 'Uploading…' : 'Send'}
              className={
                'flex h-7 w-7 items-center justify-center rounded transition-colors ' +
                (canSend
                  ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                  : 'text-zinc-600')
              }
            >
              <SendHorizontal className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="Send options"
              onClick={stub}
              disabled={!canSend}
              className={
                'flex h-7 w-5 items-center justify-center rounded transition-colors ' +
                (canSend
                  ? 'bg-emerald-700 text-white hover:bg-emerald-600 ml-px'
                  : 'text-zinc-600 ml-px')
              }
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            addFiles(files)
            if (e.target) e.target.value = '' // allow re-selecting same file
          }}
        />
      </div>

      {post.error && (
        <p className="mt-1 text-xs text-rose-400">{String(post.error)}</p>
      )}
    </form>
  )
}

// ── small toolbar atoms ───────────────────────────────────────────────────

function ToolbarBtn({
  title,
  onClick,
  disabled,
  active,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={
        'flex h-7 w-7 items-center justify-center rounded transition-colors ' +
        (active
          ? 'bg-zinc-700 text-zinc-100'
          : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100') +
        ' disabled:opacity-30 disabled:hover:bg-transparent'
      }
    >
      {children}
    </button>
  )
}

function ToolbarSep() {
  return <span className="mx-1 h-4 w-px bg-zinc-700" aria-hidden />
}

// MentionTypeahead — floats above the composer while the user is on an
// @-token. Click a row to insert the resolved mention; the editor wraps
// the inserted "@DisplayName" text with the `mention` mark so it survives
// round-trip through TipTap JSON.
function MentionTypeahead({
  candidates,
  highlight,
  onPick,
  onHoverIndex,
}: {
  candidates: MentionCandidate[]
  highlight: number
  onPick: (c: MentionCandidate) => void
  onHoverIndex: (i: number) => void
}) {
  return (
    <div className="absolute bottom-full left-3 right-3 mb-2 max-h-64 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
      <div className="border-b border-zinc-800 px-3 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
        Mention someone
      </div>
      <ul>
        {candidates.map((c, i) => (
          <li key={c.kind === 'user' ? `u:${c.userId}` : `s:${c.kind}`}>
            <button
              type="button"
              onMouseEnter={() => onHoverIndex(i)}
              onClick={() => onPick(c)}
              className={
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm ' +
                (i === highlight ? 'bg-zinc-800' : 'hover:bg-zinc-800/60')
              }
            >
              {c.kind === 'user' && c.member ? (
                <>
                  <Avatar src={c.member.avatar_url} name={c.displayName} size={20} />
                  <span className="text-zinc-100">{c.displayName}</span>
                  <span className="ml-auto text-xs text-zinc-500">{c.member.email}</span>
                </>
              ) : (
                <>
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-amber-500/20 text-[10px] font-bold text-amber-300">
                    @
                  </span>
                  <span className="text-sky-300">@{c.displayName}</span>
                  <span className="ml-auto text-xs text-zinc-500">
                    {c.kind === 'channel' && 'Notify everyone in this channel'}
                    {c.kind === 'here' && 'Notify channel (active members, currently same as @channel)'}
                    {c.kind === 'everyone' && 'Notify everyone in this channel'}
                  </span>
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// SlashTypeahead — floats above the composer card while the user is still
// on the command name. Discovery only: clicking a row prefills `/<name> `
// into the editor so the user can keep typing args. Arrow-key nav is not
// wired in yet; Enter submits whatever's in the editor (Slack does the
// same in their simpler clients).
function SlashTypeahead({
  matches,
  highlight,
  onPick,
  onHoverIndex,
}: {
  matches: SlashCommand[]
  highlight: number
  onPick: (name: string) => void
  onHoverIndex: (i: number) => void
}) {
  return (
    <div className="absolute bottom-full left-3 right-3 mb-2 max-h-64 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
      <div className="border-b border-zinc-800 px-3 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
        Commands
      </div>
      <ul>
        {matches.map((c, i) => (
          <li key={c.name}>
            <button
              type="button"
              onMouseEnter={() => onHoverIndex(i)}
              onClick={() => onPick(c.name)}
              className={
                'flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm ' +
                (i === highlight ? 'bg-zinc-800' : 'hover:bg-zinc-800/60')
              }
            >
              <span className="font-mono text-sky-400">/{c.name}</span>
              {c.usage && (
                <span className="font-mono text-xs text-zinc-500">{c.usage}</span>
              )}
              {c.description && (
                <span className="ml-auto truncate text-xs text-zinc-400">
                  {c.description}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PendingAttachmentChip({
  p,
  onRemove,
}: {
  p: PendingAttachment
  onRemove: () => void
}) {
  const isImg = p.file.type.startsWith('image/')
  return (
    <li className="relative flex items-center gap-2 rounded border border-zinc-700 bg-zinc-950 p-1 pr-2 max-w-xs">
      {isImg && p.previewURL ? (
        <img src={p.previewURL} alt="" className="h-12 w-12 object-cover rounded" />
      ) : (
        <div className="h-12 w-12 flex items-center justify-center rounded bg-zinc-900 text-zinc-400">
          <FileText className="h-6 w-6" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xs text-zinc-300 truncate" title={p.file.name}>
          {p.file.name}
        </div>
        <div className="text-[10px] text-zinc-500">{human(p.file.size)}</div>
        {p.status === 'uploading' && (
          <div className="mt-1 h-0.5 w-full rounded bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${Math.round(p.progress * 100)}%` }}
            />
          </div>
        )}
        {p.status === 'error' && (
          <div className="text-[10px] text-rose-400 truncate" title={p.error}>
            {p.error}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="text-zinc-500 hover:text-zinc-200 px-1"
        aria-label="Remove attachment"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  )
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FullPageMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-400 p-6 text-center">
      {children}
    </div>
  )
}

function FullPageError({ message }: { message: string }) {
  return (
    <div className="h-screen flex items-center justify-center bg-zinc-950 text-rose-400 p-6 text-center">
      {message}
    </div>
  )
}

// ---- modal atoms (local — Dashboard has its own copy; refactor later) ------

const modalInputClass =
  'mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none'

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function ModalField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wider text-zinc-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  )
}
