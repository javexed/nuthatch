// The external commands nuthatch sends, each with the kind of every
// argument, so that the server knows which object a command is about and
// can check it before anything reaches an engine.
//
// The author of acknowledgements, downtimes and comments is the user who
// is logged in, whatever the browser sent.

import { Refused } from './policy.ts'

/**
 * host, service: a name. int: a whole number. flag: 0 or 1. time: seconds
 * since 1970. author: replaced by the user. text: free text, last only.
 */
type Arg = 'host' | 'service' | 'int' | 'flag' | 'time' | 'author' | 'text' | 'id'
type About = 'object' | 'host-downtime' | 'service-downtime' | 'host-comment' | 'service-comment'

/** What a command is about. */
export type Target =
  | { kind: 'host'; host: string }
  | { kind: 'service'; host: string; service: string }
  | { kind: 'downtime'; id: number; service: boolean }
  | { kind: 'comment'; id: number; service: boolean }

/** Whether it takes the rights for services, not for hosts. */
export function isService(target: Target): boolean {
  return target.kind === 'service' || ((target.kind === 'downtime' || target.kind === 'comment') && target.service)
}

const COMMANDS: Record<string, [Arg[], About]> = {
  ACKNOWLEDGE_HOST_PROBLEM: [['host', 'int', 'flag', 'flag', 'author', 'text'], 'object'],
  ACKNOWLEDGE_SVC_PROBLEM: [['host', 'service', 'int', 'flag', 'flag', 'author', 'text'], 'object'],
  REMOVE_HOST_ACKNOWLEDGEMENT: [['host'], 'object'],
  REMOVE_SVC_ACKNOWLEDGEMENT: [['host', 'service'], 'object'],
  SCHEDULE_HOST_DOWNTIME: [['host', 'time', 'time', 'flag', 'int', 'int', 'author', 'text'], 'object'],
  SCHEDULE_SVC_DOWNTIME: [['host', 'service', 'time', 'time', 'flag', 'int', 'int', 'author', 'text'], 'object'],
  SCHEDULE_HOST_SVC_DOWNTIME: [['host', 'time', 'time', 'flag', 'int', 'int', 'author', 'text'], 'object'],
  DEL_HOST_DOWNTIME: [['id'], 'host-downtime'],
  DEL_SVC_DOWNTIME: [['id'], 'service-downtime'],
  ADD_HOST_COMMENT: [['host', 'flag', 'author', 'text'], 'object'],
  ADD_SVC_COMMENT: [['host', 'service', 'flag', 'author', 'text'], 'object'],
  DEL_HOST_COMMENT: [['id'], 'host-comment'],
  DEL_SVC_COMMENT: [['id'], 'service-comment'],
  SCHEDULE_FORCED_HOST_CHECK: [['host', 'time'], 'object'],
  SCHEDULE_FORCED_SVC_CHECK: [['host', 'service', 'time'], 'object'],
  SCHEDULE_FORCED_HOST_SVC_CHECKS: [['host', 'time'], 'object'],
  ENABLE_HOST_NOTIFICATIONS: [['host'], 'object'],
  DISABLE_HOST_NOTIFICATIONS: [['host'], 'object'],
  ENABLE_SVC_NOTIFICATIONS: [['host', 'service'], 'object'],
  DISABLE_SVC_NOTIFICATIONS: [['host', 'service'], 'object'],
  ENABLE_HOST_CHECK: [['host'], 'object'],
  DISABLE_HOST_CHECK: [['host'], 'object'],
  ENABLE_SVC_CHECK: [['host', 'service'], 'object'],
  DISABLE_SVC_CHECK: [['host', 'service'], 'object'],
  PROCESS_HOST_CHECK_RESULT: [['host', 'int', 'text'], 'object'],
  PROCESS_SERVICE_CHECK_RESULT: [['host', 'service', 'int', 'text'], 'object'],
}

export const COMMAND_NAMES = Object.keys(COMMANDS)

/** A command that passed: its line for the engine, and what it is about. */
export interface Checked {
  line: string
  target: Target
}

export function checkCommand(name: string, given: string[], author: string, now: number): Checked {
  const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  if (!spec) throw new Refused(`'${name}' is not a command nuthatch sends`)
  const [kinds, about] = spec
  if (given.length !== kinds.length) throw new Refused(`${name} takes ${kinds.length} arguments, not ${given.length}`)
  if (/[;\n\r]/.test(author)) throw new Refused("the user's name cannot be an author")
  const args = [...given]
  let host: string | undefined
  let service: string | undefined
  let id = 0
  kinds.forEach((kind, n) => {
    const arg = args[n] ?? ''
    const bad = (what: string) => new Refused(`${name}: argument ${n + 1} must be ${what}`)
    if (/[\n\r\0]/.test(arg)) throw bad('one line')
    if (kind !== 'text' && arg.includes(';')) throw bad("without ';'")
    switch (kind) {
      case 'host':
      case 'service':
        if (arg === '') throw bad('a name')
        if (kind === 'host') host = arg
        else service = arg
        break
      case 'int':
        if (!/^-?\d{1,15}$/.test(arg)) throw bad('a whole number')
        break
      case 'flag':
        if (arg !== '0' && arg !== '1') throw bad('0 or 1')
        break
      case 'time':
        if (!/^\d{1,15}$/.test(arg)) throw bad('a time in seconds')
        break
      case 'id':
        if (!/^\d{1,15}$/.test(arg)) throw bad('an id')
        id = Number(arg)
        break
      case 'author':
        args[n] = author
        break
      case 'text':
        break
    }
  })
  let target: Target
  if (about === 'object') {
    if (host === undefined) throw new Refused(`${name} names no object`)
    target = service === undefined ? { kind: 'host', host } : { kind: 'service', host, service }
  } else {
    target = { kind: about.endsWith('downtime') ? 'downtime' : 'comment', id, service: about.startsWith('service') }
  }
  return { line: `[${now}] ${name};${args.join(';')}`, target }
}
