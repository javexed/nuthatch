import { createRouter, createWebHistory } from 'vue-router'
import { useSession } from './stores/session'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('./views/Login.vue'), meta: { open: true } },
    { path: '/', name: 'overview', component: () => import('./views/Overview.vue') },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  const session = useSession()
  if (!session.asked) await session.load().catch(() => undefined)
  if (!session.session && !to.meta.open) return { name: 'login', query: { to: to.fullPath } }
  if (session.session && to.name === 'login') return { name: 'overview' }
  return true
})
