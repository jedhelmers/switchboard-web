import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { X } from 'lucide-react'

// A single right-side drawer the app fills with whatever content needs a
// secondary surface — threads today, member profiles / channel info / saved
// items tomorrow. The context is intentionally narrow: one slot at a time
// (Slack-style; opening a new thing replaces what was there).

export type SidebarSlot = {
  // Stable id so consumers can tell "is this *my* thing currently open?"
  // (e.g. MessageItem can highlight when its thread is the active sidebar).
  id: string
  title: string
  body: ReactNode
  // Optional handler for the close button. The default behavior — clearing
  // the slot — always runs after; this is for callers that need to do extra
  // cleanup (analytics, ref clears, etc.).
  onClose?: () => void
}

type Ctx = {
  slot: SidebarSlot | null
  open: (slot: SidebarSlot) => void
  close: () => void
  // True when `id` matches the currently-open slot.
  isOpen: (id: string) => boolean
}

const RightSidebarContext = createContext<Ctx | null>(null)

export function RightSidebarProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<SidebarSlot | null>(null)

  const open = useCallback((next: SidebarSlot) => setSlot(next), [])
  const close = useCallback(() => {
    setSlot((cur) => {
      cur?.onClose?.()
      return null
    })
  }, [])
  const isOpen = useCallback(
    (id: string) => slot?.id === id,
    [slot?.id],
  )

  const value = useMemo<Ctx>(
    () => ({ slot, open, close, isOpen }),
    [slot, open, close, isOpen],
  )

  return (
    <RightSidebarContext.Provider value={value}>
      {children}
    </RightSidebarContext.Provider>
  )
}

export function useRightSidebar(): Ctx {
  const ctx = useContext(RightSidebarContext)
  if (!ctx) {
    throw new Error('useRightSidebar must be used inside <RightSidebarProvider>')
  }
  return ctx
}

// RightSidebar — the chrome (aside, header, close button). Renders nothing
// when no slot is active so it doesn't reserve layout space. Body content is
// the responsibility of whoever called `open()`.
export function RightSidebar() {
  const { slot, close } = useRightSidebar()
  // Escape closes the sidebar — only when actually open. Mounted at window
  // level so it works regardless of where focus sits (composer, message
  // list, anywhere). Modals will need to either intercept Escape themselves
  // (most don't yet) or cope with the sidebar closing alongside them.
  useEffect(() => {
    if (!slot) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [slot, close])

  if (!slot) return null
  return (
    <aside className="flex w-[28rem] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950 min-h-0">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-semibold">{slot.title}</h2>
        <button
          type="button"
          onClick={close}
          title="Close"
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">{slot.body}</div>
    </aside>
  )
}
