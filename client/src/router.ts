import {
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from '@tanstack/react-router'
import { lazy, Suspense, createElement } from 'react'

// Lazy-loaded screens
const Shell = lazy(() => import('./components/Shell').then((m) => ({ default: m.Shell })))
const HomeScreen = lazy(() => import('./routes/HomeScreen').then((m) => ({ default: m.HomeScreen })))
const InboxScreen = lazy(() => import('./routes/InboxScreen').then((m) => ({ default: m.InboxScreen })))
const PostScreen = lazy(() => import('./routes/PostScreen').then((m) => ({ default: m.PostScreen })))
const CalendarScreen = lazy(() => import('./routes/CalendarScreen').then((m) => ({ default: m.CalendarScreen })))
const PlanScreen = lazy(() => import('./routes/PlanScreen').then((m) => ({ default: m.PlanScreen })))
const StudioScreen = lazy(() => import('./routes/StudioScreen').then((m) => ({ default: m.StudioScreen })))
const InsightsScreen = lazy(() => import('./routes/InsightsScreen').then((m) => ({ default: m.InsightsScreen })))
const BrandScreen = lazy(() => import('./routes/BrandScreen').then((m) => ({ default: m.BrandScreen })))
const ActivityScreen = lazy(() => import('./routes/ActivityScreen').then((m) => ({ default: m.ActivityScreen })))
const SettingsScreen = lazy(() => import('./routes/SettingsScreen').then((m) => ({ default: m.SettingsScreen })))
const SetupScreen = lazy(() => import('./routes/SetupScreen').then((m) => ({ default: m.SetupScreen })))

function wrap(Component: React.ComponentType) {
  return () => createElement(Suspense, { fallback: null }, createElement(Component))
}

const rootRoute = createRootRoute({
  component: () => createElement(Outlet),
})

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: wrap(Shell),
})

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: wrap(HomeScreen),
})

const inboxRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/inbox',
  component: wrap(InboxScreen),
})

const postRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/posts/$postId',
  component: wrap(PostScreen),
})

const calendarRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/calendar',
  component: wrap(CalendarScreen),
})

const planRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/plan',
  component: wrap(PlanScreen),
})

const studioNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/studio/new',
  component: wrap(StudioScreen),
})

const studioPostRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/studio/$postId',
  component: wrap(StudioScreen),
})

const insightsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/insights',
  component: wrap(InsightsScreen),
})

const brandRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/brands/$brandId',
  component: wrap(BrandScreen),
})

const activityRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/activity',
  component: wrap(ActivityScreen),
})

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings',
  component: wrap(SettingsScreen),
})

const setupRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/setup',
  component: wrap(SetupScreen),
})

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    indexRoute,
    inboxRoute,
    postRoute,
    planRoute,
    calendarRoute,
    studioNewRoute,
    studioPostRoute,
    insightsRoute,
    brandRoute,
    activityRoute,
    settingsRoute,
    setupRoute,
  ]),
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
