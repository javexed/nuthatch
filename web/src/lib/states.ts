// The states of hosts and services, their names and their order of
// severity.

export type Kind = 'host' | 'service'

export interface State {
  /** A name for people. */
  label: string
  /** A class for the colour: ok, warning, critical, unknown, pending. */
  tone: 'ok' | 'warning' | 'critical' | 'unknown' | 'pending'
}

const HOST: State[] = [
  { label: 'Up', tone: 'ok' },
  { label: 'Down', tone: 'critical' },
  { label: 'Unreachable', tone: 'unknown' },
]
const SERVICE: State[] = [
  { label: 'OK', tone: 'ok' },
  { label: 'Warning', tone: 'warning' },
  { label: 'Critical', tone: 'critical' },
  { label: 'Unknown', tone: 'unknown' },
]
const PENDING: State = { label: 'Pending', tone: 'pending' }

export function states(kind: Kind): State[] {
  return kind === 'host' ? HOST : SERVICE
}

/** The state of an object; pending until it was checked once. */
export function stateOf(kind: Kind, state: unknown, checked: unknown = 1): State {
  if (checked === 0) return PENDING
  return states(kind)[Number(state)] ?? { label: `State ${String(state)}`, tone: 'unknown' }
}
