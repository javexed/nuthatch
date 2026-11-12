// The commands the interface sends, built for a host or a service.

import type { Command } from '@nuthatch/api'

/** A host, or a service of it, on a backend. */
export interface Target {
  backend: string
  host: string
  service?: string
}

export function targetName(target: Target): string {
  return target.service === undefined ? target.host : `${target.host} / ${target.service}`
}

function on(target: Target, hostName: string, serviceName: string, ...args: (string | number)[]): Command {
  return target.service === undefined
    ? { backend: target.backend, command: hostName, args: [target.host, ...args] }
    : { backend: target.backend, command: serviceName, args: [target.host, target.service, ...args] }
}

const flag = (b: boolean) => (b ? 1 : 0)
/** The server puts the user's name here. */
const AUTHOR = '-'

export interface AckOptions {
  comment: string
  /** Stays until the object recovers, not only until its state changes. */
  sticky: boolean
  notify: boolean
  persistent: boolean
}

export function acknowledge(target: Target, o: AckOptions): Command {
  return on(target, 'ACKNOWLEDGE_HOST_PROBLEM', 'ACKNOWLEDGE_SVC_PROBLEM', o.sticky ? 2 : 1, flag(o.notify), flag(o.persistent), AUTHOR, o.comment)
}

export function removeAcknowledgement(target: Target): Command {
  return on(target, 'REMOVE_HOST_ACKNOWLEDGEMENT', 'REMOVE_SVC_ACKNOWLEDGEMENT')
}

export interface DowntimeOptions {
  comment: string
  start: number
  end: number
  /** Fixed: from start to end. Otherwise it begins when a problem does, within that window, and lasts `duration` seconds. */
  fixed: boolean
  duration: number
  /** For a host: its services too. */
  withServices?: boolean
}

export function downtime(target: Target, o: DowntimeOptions): Command[] {
  const args = [o.start, o.end, flag(o.fixed), 0, o.fixed ? 0 : o.duration, AUTHOR, o.comment]
  const out = [on(target, 'SCHEDULE_HOST_DOWNTIME', 'SCHEDULE_SVC_DOWNTIME', ...args)]
  if (target.service === undefined && o.withServices) {
    out.push({ backend: target.backend, command: 'SCHEDULE_HOST_SVC_DOWNTIME', args: [target.host, ...args] })
  }
  return out
}

export function comment(target: Target, text: string): Command {
  return on(target, 'ADD_HOST_COMMENT', 'ADD_SVC_COMMENT', 1, AUTHOR, text)
}

export function recheck(target: Target, now: number = Math.floor(Date.now() / 1000)): Command {
  return on(target, 'SCHEDULE_FORCED_HOST_CHECK', 'SCHEDULE_FORCED_SVC_CHECK', now)
}

export function setNotifications(target: Target, enabled: boolean): Command {
  return enabled ? on(target, 'ENABLE_HOST_NOTIFICATIONS', 'ENABLE_SVC_NOTIFICATIONS') : on(target, 'DISABLE_HOST_NOTIFICATIONS', 'DISABLE_SVC_NOTIFICATIONS')
}

export function setChecks(target: Target, enabled: boolean): Command {
  return enabled ? on(target, 'ENABLE_HOST_CHECK', 'ENABLE_SVC_CHECK') : on(target, 'DISABLE_HOST_CHECK', 'DISABLE_SVC_CHECK')
}

export function deleteComment(backend: string, id: number, service: boolean): Command {
  return { backend, command: service ? 'DEL_SVC_COMMENT' : 'DEL_HOST_COMMENT', args: [id] }
}

export function deleteDowntime(backend: string, id: number, service: boolean): Command {
  return { backend, command: service ? 'DEL_SVC_DOWNTIME' : 'DEL_HOST_DOWNTIME', args: [id] }
}
