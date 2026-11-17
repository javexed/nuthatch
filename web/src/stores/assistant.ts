import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AssistantTurn } from '@nuthatch/api'
import { api } from './session'

/** The page a question is asked from. */
export interface About {
  backend: string
  host: string
  service?: string
}

/** A turn as shown: an answer also lists what it looked at. */
export interface Shown {
  role: 'user' | 'assistant'
  text: string
  looked: string[]
  failed?: string
}

/** The conversation with the assistant, kept while the page is open. */
export const useAssistant = defineStore('assistant', () => {
  const open = ref(false)
  const turns = ref<Shown[]>([])
  const busy = ref(false)
  let abort: AbortController | null = null

  /** What the server is sent: question and answer pairs that worked, and the new question. */
  function history(question: string): AssistantTurn[] {
    const out: AssistantTurn[] = []
    for (let n = 0; n + 1 < turns.value.length; n += 2) {
      const [q, a] = [turns.value[n], turns.value[n + 1]]
      if (q && a && a.text.trim() !== '' && !a.failed) out.push({ role: 'user', text: q.text }, { role: 'assistant', text: a.text })
    }
    return [...out.slice(-38), { role: 'user', text: question }]
  }

  async function ask(question: string, about?: About): Promise<void> {
    const text = question.trim()
    if (text === '' || busy.value) return
    const sent = history(text)
    turns.value.push({ role: 'user', text, looked: [] })
    turns.value.push({ role: 'assistant', text: '', looked: [] })
    const answer = turns.value[turns.value.length - 1] as Shown
    busy.value = true
    abort = new AbortController()
    try {
      await api.ask(
        sent,
        about,
        (event) => {
          if (event.kind === 'text') answer.text += event.text
          else if (event.kind === 'tool') answer.looked.push(event.text)
          else if (event.kind === 'error') answer.failed = event.error
        },
        abort.signal,
      )
    } catch (err) {
      if (!abort.signal.aborted) answer.failed = err instanceof Error ? err.message : String(err)
      else if (answer.text === '') answer.failed = 'stopped'
    } finally {
      busy.value = false
      abort = null
    }
  }

  /** Opens the panel and asks about a host or service. */
  function explain(about: About): void {
    open.value = true
    void ask('Explain this problem.', about)
  }

  function stop(): void {
    abort?.abort()
  }

  function clear(): void {
    stop()
    turns.value = []
  }

  return { open, turns, busy, ask, explain, stop, clear }
})
