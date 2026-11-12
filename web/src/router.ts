import { createRouter, createWebHistory } from 'vue-router'
import { useSession } from './stores/session'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('./views/Login.vue'), meta: { open: true } },
    { path: '/', name: 'overview', component: () => import('./views/Overview.vue') },
    { path: '/problems', name: 'problems', component: () => import('./views/Problems.vue') },
    { path: '/hosts', name: 'hosts', component: () => import('./views/Hosts.vue') },
    { path: '/services', name: 'services', component: () => import('./views/Services.vue') },
    { path: '/hostgroups', name: 'hostgroups', component: () => import('./views/Groups.vue'), props: { kind: 'host' } },
    { path: '/servicegroups', name: 'servicegroups', component: () => import('./views/Groups.vue'), props: { kind: 'service' } },
    { path: '/history', name: 'history', component: () => import('./views/History.vue') },
    { path: '/availability', name: 'availability', component: () => import('./views/Availability.vue') },
    { path: '/dashboards', name: 'dashboards', component: () => import('./views/Dashboards.vue') },
    { path: '/dashboard/:id', name: 'dashboard', component: () => import('./views/DashboardView.vue'), props: true },
    { path: '/config', name: 'config', component: () => import('./views/Config.vue') },
    { path: '/host/:backend/:host', name: 'host', component: () => import('./views/Detail.vue'), props: true },
    { path: '/service/:backend/:host/:service', name: 'service', component: () => import('./views/Detail.vue'), props: true },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
  scrollBehavior: (to, from, saved) => saved ?? (to.path === from.path ? undefined : { top: 0 }),
})

router.beforeEach(async (to) => {
  const session = useSession()
  if (!session.asked) await session.load().catch(() => undefined)
  if (!session.session && !to.meta.open) return { name: 'login', query: { to: to.fullPath } }
  if (session.session && to.name === 'login') return { name: 'overview' }
  return true
})
