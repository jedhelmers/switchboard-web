// Huddle — fullscreen overlay that hosts a LiveKit room for a channel.
//
// The Stack server mints a JWT (POST /v1/channels/:id/huddle/join); we hand
// the URL + token to <LiveKitRoom> and compose our own UI on top of
// @livekit/components-react primitives. We deliberately skip the
// <VideoConference> prefab so the look matches the rest of the app
// instead of LiveKit's stock dark theme.
//
//   • While we wait for the token mint, render a "joining…" spinner.
//   • If the mint fails (most likely cause: huddles disabled on the
//     server, i.e. LIVEKIT_API_KEY unset → 503), show a readable error
//     instead of a blank room.
//   • On unmount or explicit close, call POST .../huddle/leave so the
//     server marks us out and (if we were the last) ends the huddle.
//
// Layouts:
//   - grid        — equal tiles (default for small rooms)
//   - spotlight   — one main tile + side strip; user pins by clicking
//   - speaker     — spotlight, but main auto-follows the active speaker
//   Screen shares auto-promote to spotlight and pin themselves. Local
//   participant can be hidden from the stage (PiP self preview instead).

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VideoTrack,
  ParticipantName,
  ParticipantContextIfNeeded,
  useTracks,
  useParticipants,
  useLocalParticipant,
  useSpeakingParticipants,
  useIsSpeaking,
  useIsMuted,
  useTrackToggle,
  useDisconnectButton,
} from '@livekit/components-react'
import { Track, VideoPresets } from 'livekit-client'
import type { RoomOptions } from 'livekit-client'
import type { TrackReferenceOrPlaceholder } from '@livekit/components-core'
import { useJoinHuddle, useLeaveHuddle, type HuddleJoinResponse } from '@stack/client'
import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  MonitorUp,
  PhoneOff,
  X,
  User,
  LayoutGrid,
  Square,
  AudioLines,
  PictureInPicture,
  Pin,
} from 'lucide-react'

type Layout = 'grid' | 'spotlight' | 'speaker'
type TileKey = string // `${identity}:${source}`

function tileKey(t: TrackReferenceOrPlaceholder): TileKey {
  return `${t.participant.identity}:${t.source}`
}

type Props = {
  channelId: string
  channelLabel: string // shown in the header — e.g. "# huddle-test"
  onClose: () => void
}

export function Huddle({ channelId, channelLabel, onClose }: Props) {
  const join = useJoinHuddle(channelId)
  const leave = useLeaveHuddle(channelId)
  // Track whether we successfully mounted into LiveKit so the unmount
  // cleanup only fires LEAVE for sessions that actually started. Spares
  // the server a 204 on every render of a 503-erroring overlay.
  const enteredRef = useRef(false)

  useEffect(() => {
    join.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])

  useEffect(() => {
    return () => {
      if (enteredRef.current) {
        leave.mutate()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800/80 px-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
          <span className="font-medium text-zinc-100">Huddle</span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-400">{channelLabel}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close (leaves the huddle)"
          className="flex h-8 w-8 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="relative flex-1 min-h-0">
        {join.isPending && <Centered label="Joining huddle…" />}
        {join.isError && (
          <Centered
            label={errorLabel(join.error)}
            detail="Check that LIVEKIT_API_KEY is set on the server and the api container has been rebuilt."
          />
        )}
        {join.data && (
          <LiveKitJoined
            data={join.data}
            onEntered={() => {
              enteredRef.current = true
            }}
            onDisconnect={onClose}
          />
        )}
      </div>
    </div>
  )
}

// LiveKitJoined isolates the <LiveKitRoom> tree so React doesn't try to
// re-mount it on every parent render. The room's lifecycle (connect →
// publish tracks → disconnect) is expensive; keeping it stable matters.
function LiveKitJoined({
  data,
  onEntered,
  onDisconnect,
}: {
  data: HuddleJoinResponse
  onEntered: () => void
  onDisconnect: () => void
}) {
  return (
    <LiveKitRoom
      serverUrl={data.livekit_url}
      token={data.livekit_token}
      connect={true}
      audio={true}
      video={false}
      onConnected={onEntered}
      onDisconnected={onDisconnect}
      options={huddleRoomOptions}
      className="flex h-full flex-col"
    >
      <HuddleRoom onLeave={onDisconnect} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  )
}

// huddleRoomOptions — fidelity + bandwidth tuning. Module-scope (not inside
// the component) so React's reconciler can't accidentally hand <LiveKitRoom>
// a fresh object on every render, which would re-construct the underlying
// Room and tear down any in-flight tracks.
//
// The four dials:
//   • videoCaptureDefaults.resolution = h1080 — the camera publishes a 1080p
//     source. With simulcast on, this becomes the *highest* of three
//     simulcast layers; subscribers only pay for it when a tile is big
//     enough to actually display it.
//   • publishDefaults.videoSimulcastLayers — three rungs of the ladder. The
//     publisher encodes whatever rungs are being subscribed to (see
//     dynacast); the SFU forwards the appropriate rung per subscriber
//     based on their tile size (see adaptiveStream).
//   • publishDefaults.videoCodec = 'vp9' — better quality-per-bit than the
//     VP8 default. Chrome + Firefox both negotiate it natively; Safari
//     falls back to VP8 automatically.
//   • publishDefaults.videoEncoding.maxBitrate = 3 Mbps — caps the top
//     simulcast layer. Default is around 1.5 Mbps for 720p, which is
//     ammunition starved for 1080p. 3 Mbps cleans up motion + screen
//     share without saturating localhost.
//
// adaptiveStream + dynacast are the bandwidth-minimization layer:
//   • adaptiveStream observes each <VideoTrack> element's actual on-screen
//     size and asks the SFU for the simulcast layer that matches. Small
//     tiles get the small layer; full-screen tiles get 1080p.
//   • dynacast tells the publisher to stop encoding layers no subscriber
//     is currently consuming. If everyone's in tiny tiles, the publisher
//     only encodes the low layer and saves the CPU.
//
// Together: you get 1080p when something's big, near-zero waste when it
// isn't, and the publisher's encoder isn't burning cycles on dead layers.
const huddleRoomOptions: RoomOptions = {
  adaptiveStream: true,
  dynacast: true,
  videoCaptureDefaults: {
    resolution: VideoPresets.h1080.resolution,
  },
  publishDefaults: {
    videoSimulcastLayers: [
      VideoPresets.h360,
      VideoPresets.h720,
      VideoPresets.h1080,
    ],
    videoCodec: 'vp9',
    videoEncoding: {
      maxBitrate: 3_000_000,
      maxFramerate: 30,
    },
    // Screen share is uplink-heavy too — bump it explicitly. Without this
    // it inherits a conservative default and presentations look soft.
    screenShareEncoding: {
      maxBitrate: 4_000_000,
      maxFramerate: 15,
    },
  },
}

// HuddleRoom owns the layout / pin / hide-self state. It must live
// *inside* <LiveKitRoom> so the LiveKit hooks have a room context.
function HuddleRoom({ onLeave }: { onLeave: () => void }) {
  const [layout, setLayout] = useState<Layout>('grid')
  const [pinned, setPinned] = useState<TileKey | null>(null)
  const [hideSelf, setHideSelf] = useState(false)
  // Camera tracks (with placeholders for participants without video),
  // plus all active screen-share tracks as extra tiles.
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  )
  const { localParticipant } = useLocalParticipant()
  const localIdentity = localParticipant?.identity

  // Active speakers for the Speaker layout. Keep the last non-empty
  // speaker so the focus doesn't flicker back when everyone falls silent.
  const speakers = useSpeakingParticipants()
  const lastSpeakerRef = useRef<string | null>(null)
  useEffect(() => {
    const first = speakers.find((p) => p.identity !== localIdentity) ?? speakers[0]
    if (first) lastSpeakerRef.current = first.identity
  }, [speakers, localIdentity])

  // Auto-spotlight on screen share. When a share appears we save the
  // user's current layout and switch to spotlight+pin-share; when the
  // share ends we restore. If the user manually picks a layout while a
  // share is active, that becomes the new "saved" layout.
  const firstShare = tracks.find((t) => t.source === Track.Source.ScreenShare)
  const shareKey = firstShare ? tileKey(firstShare) : null
  const savedLayoutRef = useRef<Layout | null>(null)
  const autoPinShareRef = useRef<TileKey | null>(null)
  useEffect(() => {
    if (shareKey) {
      // New share started.
      if (autoPinShareRef.current !== shareKey) {
        savedLayoutRef.current = layout
        autoPinShareRef.current = shareKey
        setLayout('spotlight')
        setPinned(shareKey)
      }
    } else if (autoPinShareRef.current) {
      // Share ended — restore.
      const saved = savedLayoutRef.current ?? 'grid'
      autoPinShareRef.current = null
      savedLayoutRef.current = null
      setLayout(saved)
      setPinned((cur) => (cur && cur.endsWith(`:${Track.Source.ScreenShare}`) ? null : cur))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareKey])

  // Manual layout change clears any auto-pin so the user's choice sticks.
  const chooseLayout = (next: Layout) => {
    setLayout(next)
    if (next === 'grid') setPinned(null)
  }

  // Tile click → pin/unpin. Picking a new pin switches to spotlight.
  const onPinToggle = (key: TileKey) => {
    setPinned((cur) => {
      if (cur === key) return null
      return key
    })
    if (layout === 'grid') setLayout('spotlight')
  }

  // Stage tiles: hide local from the grid/strip when PiP-self is on.
  const stageTiles = useMemo(
    () => (hideSelf ? tracks.filter((t) => t.participant.identity !== localIdentity) : tracks),
    [tracks, hideSelf, localIdentity],
  )

  // Resolve the focused (main) tile for spotlight/speaker layouts.
  const focused: TrackReferenceOrPlaceholder | null = useMemo(() => {
    if (layout === 'grid') return null
    if (pinned) {
      const t = stageTiles.find((x) => tileKey(x) === pinned)
      if (t) return t
    }
    if (layout === 'speaker' && lastSpeakerRef.current) {
      const t = stageTiles.find(
        (x) =>
          x.source === Track.Source.Camera &&
          x.participant.identity === lastSpeakerRef.current,
      )
      if (t) return t
    }
    // Fallback: first remote camera, else first camera at all.
    return (
      stageTiles.find(
        (x) => x.source === Track.Source.Camera && x.participant.identity !== localIdentity,
      ) ??
      stageTiles.find((x) => x.source === Track.Source.Camera) ??
      stageTiles[0] ??
      null
    )
  }, [layout, pinned, stageTiles, localIdentity])

  const stripTiles = focused
    ? stageTiles.filter((t) => tileKey(t) !== tileKey(focused))
    : stageTiles

  return (
    <>
      <div className="relative flex-1 min-h-0">
        <LayoutSwitcher
          layout={layout}
          onChange={chooseLayout}
          hideSelf={hideSelf}
          onToggleHideSelf={() => setHideSelf((v) => !v)}
        />

        {layout === 'grid' ? (
          <GridStage tiles={stageTiles} pinned={pinned} onPinToggle={onPinToggle} />
        ) : (
          <SpotlightStage
            focused={focused}
            strip={stripTiles}
            pinned={pinned}
            onPinToggle={onPinToggle}
          />
        )}

        {hideSelf && localIdentity && <SelfPip tracks={tracks} localIdentity={localIdentity} />}
      </div>

      <ControlBar onLeave={onLeave} />
    </>
  )
}

// ─── Layout switcher ────────────────────────────────────────────────

function LayoutSwitcher({
  layout,
  onChange,
  hideSelf,
  onToggleHideSelf,
}: {
  layout: Layout
  onChange: (l: Layout) => void
  hideSelf: boolean
  onToggleHideSelf: () => void
}) {
  return (
    <div className="absolute right-4 top-4 z-10 flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/80 p-1 shadow-lg backdrop-blur">
      <SegBtn label="Grid" title="Grid" active={layout === 'grid'} onClick={() => onChange('grid')}>
        <LayoutGrid className="h-4 w-4" />
      </SegBtn>
      <SegBtn
        label="Spotlight"
        title="Spotlight"
        active={layout === 'spotlight'}
        onClick={() => onChange('spotlight')}
      >
        <Square className="h-4 w-4" />
      </SegBtn>
      <SegBtn
        label="Speaker"
        title="Speaker (auto-follow)"
        active={layout === 'speaker'}
        onClick={() => onChange('speaker')}
      >
        <AudioLines className="h-4 w-4" />
      </SegBtn>
      <span className="mx-1 h-5 w-px bg-zinc-800" />
      <SegBtn
        label="Self-PiP"
        title={hideSelf ? 'Show self in stage' : 'Hide self (picture-in-picture)'}
        active={hideSelf}
        onClick={onToggleHideSelf}
      >
        <PictureInPicture className="h-4 w-4" />
      </SegBtn>
    </div>
  )
}

function SegBtn({
  children,
  label,
  title,
  active,
  onClick,
}: {
  children: React.ReactNode
  label: string
  title: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      aria-pressed={active}
      className={[
        'flex h-8 items-center justify-center rounded-full px-2.5 text-xs font-medium transition-colors',
        active
          ? 'bg-zinc-100 text-zinc-900'
          : 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

// ─── Stages ─────────────────────────────────────────────────────────

function GridStage({
  tiles,
  pinned,
  onPinToggle,
}: {
  tiles: TrackReferenceOrPlaceholder[]
  pinned: TileKey | null
  onPinToggle: (k: TileKey) => void
}) {
  const cols = gridCols(tiles.length)
  return (
    <div className="absolute inset-0 overflow-auto px-6 pt-6 pb-32">
      <div
        className="mx-auto grid w-full max-w-6xl gap-4"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {tiles.map((t) => (
          <Tile
            key={tileKey(t)}
            trackRef={t}
            pinned={pinned === tileKey(t)}
            onPinToggle={onPinToggle}
          />
        ))}
      </div>
    </div>
  )
}

function SpotlightStage({
  focused,
  strip,
  pinned,
  onPinToggle,
}: {
  focused: TrackReferenceOrPlaceholder | null
  strip: TrackReferenceOrPlaceholder[]
  pinned: TileKey | null
  onPinToggle: (k: TileKey) => void
}) {
  return (
    <div className="absolute inset-0 flex gap-4 px-6 pt-6 pb-32">
      <div className="min-w-0 flex-1">
        {focused ? (
          <Tile
            trackRef={focused}
            pinned={pinned === tileKey(focused)}
            onPinToggle={onPinToggle}
            size="hero"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center rounded-xl bg-zinc-900 text-sm text-zinc-500">
            No one here yet
          </div>
        )}
      </div>
      {strip.length > 0 && (
        <div className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto pr-1">
          {strip.map((t) => (
            <Tile
              key={tileKey(t)}
              trackRef={t}
              pinned={pinned === tileKey(t)}
              onPinToggle={onPinToggle}
              size="thumb"
            />
          ))}
        </div>
      )}
    </div>
  )
}

function gridCols(n: number): number {
  if (n <= 1) return 1
  if (n <= 4) return 2
  if (n <= 9) return 3
  return 4
}

// ─── Tile ───────────────────────────────────────────────────────────

function Tile({
  trackRef,
  pinned,
  onPinToggle,
  size = 'normal',
}: {
  trackRef: TrackReferenceOrPlaceholder
  pinned: boolean
  onPinToggle: (k: TileKey) => void
  size?: 'normal' | 'thumb' | 'hero'
}) {
  const isScreenShare = trackRef.source === Track.Source.ScreenShare
  const hasVideo = !!trackRef.publication && !trackRef.publication.isMuted
  const isSpeaking = useIsSpeaking(trackRef.participant)
  // Mic-muted indicator — read against the microphone track, not the
  // tile's track (which is the camera for camera tiles).
  const micRef: TrackReferenceOrPlaceholder = {
    participant: trackRef.participant,
    source: Track.Source.Microphone,
    publication: trackRef.participant.getTrackPublication(Track.Source.Microphone),
  }
  const micMuted = useIsMuted(micRef)

  const sizing =
    size === 'hero'
      ? 'h-full w-full'
      : size === 'thumb'
        ? 'aspect-video w-full'
        : 'aspect-video w-full'

  return (
    <ParticipantContextIfNeeded participant={trackRef.participant}>
      <div
        onClick={() => onPinToggle(tileKey(trackRef))}
        className={[
          'group relative cursor-pointer overflow-hidden rounded-xl bg-zinc-900',
          'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]',
          'transition-shadow duration-150',
          sizing,
          isSpeaking && !isScreenShare
            ? 'ring-2 ring-emerald-500/80 ring-offset-2 ring-offset-zinc-950'
            : '',
          pinned ? 'ring-2 ring-sky-500/70 ring-offset-2 ring-offset-zinc-950' : '',
        ].join(' ')}
        title={pinned ? 'Click to unpin' : 'Click to pin to spotlight'}
      >
        {hasVideo ? (
          <VideoTrack
            trackRef={trackRef as never}
            className={
              isScreenShare || size === 'hero'
                ? 'h-full w-full object-contain'
                : 'h-full w-full object-cover'
            }
          />
        ) : (
          <Placeholder size={size} />
        )}

        {isScreenShare && (
          <div className="absolute left-3 top-3 rounded-md bg-zinc-950/70 px-2 py-1 text-[11px] font-medium text-zinc-200 backdrop-blur">
            Screen
          </div>
        )}

        {pinned && (
          <div className="absolute right-3 top-3 flex items-center gap-1 rounded-md bg-sky-500/15 px-2 py-1 text-[11px] font-medium text-sky-300 backdrop-blur">
            <Pin className="h-3 w-3" />
            Pinned
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-zinc-950/80 via-zinc-950/40 to-transparent px-3 pb-2 pt-6">
          <div className="flex min-w-0 items-center gap-1.5 text-sm text-zinc-100">
            {micMuted ? (
              <MicOff className="h-3.5 w-3.5 shrink-0 text-rose-400" />
            ) : (
              <Mic className="h-3.5 w-3.5 shrink-0 text-zinc-300" />
            )}
            <ParticipantName className="truncate" />
          </div>
        </div>
      </div>
    </ParticipantContextIfNeeded>
  )
}

function Placeholder({ size }: { size: 'normal' | 'thumb' | 'hero' }) {
  const ringSize =
    size === 'hero' ? 'h-32 w-32' : size === 'thumb' ? 'h-12 w-12' : 'h-20 w-20'
  const iconSize =
    size === 'hero' ? 'h-16 w-16' : size === 'thumb' ? 'h-6 w-6' : 'h-10 w-10'
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900">
      <div
        className={`flex ${ringSize} items-center justify-center rounded-full bg-zinc-700/60 text-zinc-300`}
      >
        <User className={iconSize} />
      </div>
    </div>
  )
}

// ─── Self picture-in-picture ────────────────────────────────────────

function SelfPip({
  tracks,
  localIdentity,
}: {
  tracks: TrackReferenceOrPlaceholder[]
  localIdentity: string
}) {
  // Prefer the local camera track; if camera is off, use the placeholder.
  const selfCam =
    tracks.find(
      (t) =>
        t.participant.identity === localIdentity && t.source === Track.Source.Camera,
    ) ?? null
  if (!selfCam) return null
  const hasVideo = !!selfCam.publication && !selfCam.publication.isMuted
  return (
    <div className="pointer-events-none absolute bottom-28 right-6 z-10 w-56">
      <ParticipantContextIfNeeded participant={selfCam.participant}>
        <div className="relative aspect-video overflow-hidden rounded-lg bg-zinc-900 shadow-xl shadow-black/40 ring-1 ring-zinc-800">
          {hasVideo ? (
            <VideoTrack
              trackRef={selfCam as never}
              className="h-full w-full -scale-x-100 object-cover"
            />
          ) : (
            <Placeholder size="thumb" />
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-zinc-950/80 to-transparent px-2 pb-1.5 pt-4 text-[11px] text-zinc-200">
            You
          </div>
        </div>
      </ParticipantContextIfNeeded>
    </div>
  )
}

// ─── Control bar ────────────────────────────────────────────────────

function ControlBar({ onLeave }: { onLeave: () => void }) {
  const participants = useParticipants()
  const { localParticipant } = useLocalParticipant()

  const mic = useTrackToggle({ source: Track.Source.Microphone })
  const cam = useTrackToggle({ source: Track.Source.Camera })
  const screen = useTrackToggle({ source: Track.Source.ScreenShare })

  const disconnect = useDisconnectButton({})

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/95 px-3 py-2 shadow-xl backdrop-blur">
        <span className="px-2 text-xs text-zinc-400">
          {participants.length} {participants.length === 1 ? 'person' : 'people'}
        </span>
        <span className="h-6 w-px bg-zinc-800" />

        <CtrlButton
          label={mic.enabled ? 'Mute' : 'Unmute'}
          danger={!mic.enabled}
          pending={mic.pending}
          onClick={() => mic.toggle()}
          title={mic.enabled ? 'Mute microphone' : 'Unmute microphone'}
        >
          {mic.enabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
        </CtrlButton>

        <CtrlButton
          label={cam.enabled ? 'Stop video' : 'Start video'}
          danger={!cam.enabled}
          pending={cam.pending}
          onClick={() => cam.toggle()}
          title={cam.enabled ? 'Turn camera off' : 'Turn camera on'}
        >
          {cam.enabled ? (
            <VideoIcon className="h-4 w-4" />
          ) : (
            <VideoOff className="h-4 w-4" />
          )}
        </CtrlButton>

        <CtrlButton
          label={screen.enabled ? 'Stop share' : 'Share'}
          active={screen.enabled}
          pending={screen.pending}
          onClick={() => screen.toggle()}
          title={screen.enabled ? 'Stop screen share' : 'Share screen'}
          disabled={!localParticipant?.permissions?.canPublish}
        >
          <MonitorUp className="h-4 w-4" />
        </CtrlButton>

        <span className="h-6 w-px bg-zinc-800" />

        <button
          type="button"
          {...disconnect.buttonProps}
          onClick={(e) => {
            disconnect.buttonProps.onClick?.(e)
            // onDisconnected on <LiveKitRoom> will fire onLeave too, but
            // call it eagerly so the overlay closes without a frame of
            // post-disconnect emptiness.
            onLeave()
          }}
          title="Leave huddle"
          className="flex items-center gap-2 rounded-full bg-rose-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-rose-500 active:bg-rose-700"
        >
          <PhoneOff className="h-4 w-4" />
          <span>Leave</span>
        </button>
      </div>
    </div>
  )
}

function CtrlButton({
  children,
  label,
  onClick,
  title,
  danger,
  active,
  pending,
  disabled,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  title: string
  danger?: boolean
  active?: boolean
  pending?: boolean
  disabled?: boolean
}) {
  const base =
    'flex h-10 w-10 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40'
  const style = danger
    ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
    : active
      ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
      : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={title}
        disabled={disabled || pending}
        className={`${base} ${style}`}
      >
        {children}
      </button>
      <span className="text-[10px] leading-none text-zinc-500">{label}</span>
    </div>
  )
}

function Centered({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-zinc-300">
      <div className="text-sm">{label}</div>
      {detail && <div className="max-w-md text-center text-xs text-zinc-500">{detail}</div>}
    </div>
  )
}

// Surface the 503 case readably so we don't just stare at "request failed".
function errorLabel(err: unknown): string {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: number }).status
    if (status === 503) return 'Huddles are not configured on this server.'
  }
  return 'Could not join the huddle.'
}
