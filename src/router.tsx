import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  RouterProvider,
  useNavigate,
  useParams,
} from '@tanstack/react-router'
import { useMe } from './api/hooks'
import { Login } from './components/Login'
import { Chat } from './components/Chat'
import { Dashboard } from './components/Dashboard'
import { InviteAccept } from './components/InviteAccept'
import { RightSidebarProvider } from './components/RightSidebar'

// Single source of truth for auth gating. We check the cached /me query.
// If you land on a protected route while logged out you bounce to /login;
// if you land on /login while logged in you bounce to /chat.

const rootRoute = createRootRoute({
  component: () => <Outlet />,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/chat' })
  },
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginScreen,
})

const inviteAcceptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: InviteAcceptScreen,
})

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  component: () => <ChatScreen />,
})

const chatWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat/$workspace',
  component: ChatWorkspaceScreen,
})

const chatChannelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat/$workspace/$channel',
  component: ChatChannelScreen,
})

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: () => <Outlet />,
})

const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  component: () => <DashboardScreen tab="stats" />,
})

const adminTabRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '$tab',
  component: DashboardTabScreen,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  inviteAcceptRoute,
  chatRoute,
  chatWorkspaceRoute,
  chatChannelRoute,
  adminRoute.addChildren([adminIndexRoute, adminTabRoute]),
])

export const router = createRouter({ routeTree, defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />
}

// ---- screen wrappers (handle the auth gate per-route) ---------------------

function InviteAcceptScreen() {
  const { token } = useParams({ from: inviteAcceptRoute.id })
  const { data: user, isLoading } = useMe()
  const navigate = useNavigate()
  if (isLoading) return <Loading />
  if (user) {
    // Already signed in — sending them to chat is the only sensible move.
    // (Redeeming an invite while logged in would create a second account.)
    return (
      <main className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 text-zinc-300 p-6 text-center gap-3">
        <p>You're already signed in as <span className="text-zinc-100">{user.email}</span>.</p>
        <p className="text-sm text-zinc-500">
          Sign out first if you want to redeem this invite as a different account.
        </p>
        <button
          onClick={() => navigate({ to: '/chat' })}
          className="mt-2 rounded bg-zinc-100 text-zinc-900 px-3 py-1.5 text-sm font-medium hover:bg-white"
        >
          Go to chat
        </button>
      </main>
    )
  }
  return <InviteAccept token={token} onAccepted={() => navigate({ to: '/chat' })} />
}

function LoginScreen() {
  const { data: user, isLoading } = useMe()
  const navigate = useNavigate()
  if (isLoading) return <Loading />
  if (user) {
    // already signed in — bounce to chat
    navigate({ to: '/chat', replace: true })
    return null
  }
  return <Login />
}

function ChatScreen({ workspace, channel }: { workspace?: string; channel?: string } = {}) {
  const { data: user, isLoading, error } = useMe()
  const navigate = useNavigate()
  if (isLoading) return <Loading />
  if (error) return <ErrorMsg message={String(error)} />
  if (!user) {
    navigate({ to: '/login', replace: true })
    return null
  }
  return (
    <RightSidebarProvider>
      <Chat
        user={user}
        activeWorkspaceSlug={workspace ?? null}
        activeChannelId={channel ?? null}
        onSelectWorkspace={(slug) =>
          navigate({ to: '/chat/$workspace', params: { workspace: slug } })
        }
        onSelectChannel={(slug, channelId) =>
          navigate({
            to: '/chat/$workspace/$channel',
            params: { workspace: slug, channel: channelId },
          })
        }
        onOpenDashboard={
          user.is_operator ? () => navigate({ to: '/admin' }) : undefined
        }
      />
    </RightSidebarProvider>
  )
}

function ChatWorkspaceScreen() {
  const { workspace } = useParams({ from: chatWorkspaceRoute.id })
  return <ChatScreen workspace={workspace} />
}

function ChatChannelScreen() {
  const { workspace, channel } = useParams({ from: chatChannelRoute.id })
  return <ChatScreen workspace={workspace} channel={channel} />
}

function DashboardScreen({ tab }: { tab: string }) {
  const { data: user, isLoading, error } = useMe()
  const navigate = useNavigate()
  if (isLoading) return <Loading />
  if (error) return <ErrorMsg message={String(error)} />
  if (!user) {
    navigate({ to: '/login', replace: true })
    return null
  }
  if (!user.is_operator) {
    navigate({ to: '/chat', replace: true })
    return null
  }
  return (
    <Dashboard
      user={user}
      activeTab={tab as DashboardTab}
      onTabChange={(t) => navigate({ to: '/admin/$tab', params: { tab: t } })}
      onExit={() => navigate({ to: '/chat' })}
    />
  )
}

function DashboardTabScreen() {
  const { tab } = useParams({ from: adminTabRoute.id })
  return <DashboardScreen tab={tab} />
}

// keep this in sync with Dashboard.tsx Tab type
type DashboardTab = 'stats' | 'workspaces' | 'channels' | 'dms' | 'users' | 'audit' | 'health'

function Loading() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-400">
      Loading…
    </main>
  )
}

function ErrorMsg({ message }: { message: string }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 text-rose-400 p-6 text-center">
      Couldn't reach the server: {message}
    </main>
  )
}
