// What a dashboard is about, chosen in the row at its top, and what a
// panel that follows it shows. "Any host" is a host picked from a list;
// once picked it is a host like any other. Nothing chosen (All) is
// everything.
import type { Scope, Subject } from '@nuthatch/api'

/** A subject as the panels see it: "any host" has become the host picked. */
export type Focus = { kind: 'host'; backend: string; host: string } | { kind: 'hostgroup'; name: string } | { kind: 'servicegroup'; name: string }

export const subjectKey = (s: Subject): string => (s.kind === 'host' ? `host\n${s.backend}\n${s.host}` : s.kind === 'any' ? `any\n${s.hostgroup ?? ''}` : `${s.kind}\n${s.name}`)
export const subjectName = (s: Subject | Focus): string => (s.kind === 'host' ? s.host : s.kind === 'any' ? (s.hostgroup ? `Any host of ${s.hostgroup}` : 'Any host') : s.name)

/** What a following status or uptime panel covers. */
export function scopeOf(focus: Focus | null): Scope {
  if (!focus) return {}
  if (focus.kind === 'host') return { of: { backend: focus.backend, host: focus.host } }
  return focus.kind === 'hostgroup' ? { hostgroup: focus.name } : { servicegroup: focus.name }
}

