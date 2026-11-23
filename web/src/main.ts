import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { startTheme } from './lib/theme'
import './style.css'

startTheme()
createApp(App).use(createPinia()).use(router).mount('#app')

// In a browser, the service worker that makes nuthatch installable as an
// app (public/sw.js). Not in the phone app, which carries its files.
if (import.meta.env.MODE !== 'app' && 'serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD) {
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined)
}
