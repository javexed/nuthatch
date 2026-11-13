declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

/** The id of this build, also in version.json (vite.config.ts). */
declare const __NUTHATCH_BUILD__: string
