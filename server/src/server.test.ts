import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Role } from '@nuthatch/api'
import bcrypt from 'bcryptjs'
import * as unixcrypt from 'unixcrypt'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { Htpasswd, Limiter, verify } from './auth.ts'
import type { Backend } from './backend.ts'
import { checkCommand, isService } from './commands.ts'
import { Events } from './events.ts'
import { RolesConfig, access, checkColumns, checkHeaders } from './policy.ts'
import { compare, limits, merge, rows, stats } from './query.ts'
import { Store } from './store.ts'

const roles = (...held: Role[]) => new Set<Role>(held)

describe('the store', () => {
  it('keeps sessions, tokens, preferences and the audit log', () => {
    const store = new Store(':memory:')
    const { cookie, session } = store.newSession('ann')
    expect(store.session(cookie)).toEqual(session)
    expect(store.session('not a cookie')).toBeNull()
    store.endSession(cookie)
    expect(store.session(cookie)).toBeNull()

    const { id, token } = store.newToken('ann', 'phone')
    expect(store.tokenUser(token)).toBe('ann')
    expect(store.tokens('ann')).toHaveLength(1)
    expect(store.deleteToken('bob', id)).toBe(false)
    expect(store.deleteToken('ann', id)).toBe(true)
    expect(store.tokenUser(token)).toBeNull()

    store.setPref('ann', 'theme', '"dark"')
    store.setPref('ann', 'theme', '"light"')
    expect(store.pref('ann', 'theme')).toBe('"light"')
    expect(store.pref('bob', 'theme')).toBeNull()

    store.audit('ann', 'site', 'command', 'x')
    expect(store.auditTail(5)).toHaveLength(1)
  })
})

describe('passwords', () => {
  it('reads apr1 as openssl writes it', async () => {
    // openssl passwd -apr1 -salt <salt> <password>
    expect(await verify('s3cret', '$apr1$Xy12AbCd$J016AtqHNNVnJHmaiyxUC1')).toBe(true)
    expect(await verify('a much longer password than sixteen bytes', '$apr1$ab$ZgbyBttfAvWjwKDroS41O1')).toBe(true)
    expect(await verify('s3cred', '$apr1$Xy12AbCd$J016AtqHNNVnJHmaiyxUC1')).toBe(false)
  })

  it('checks each form of an htpasswd file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuthatch-auth-'))
    const file = join(dir, 'htpasswd')
    writeFileSync(file, `ann:${bcrypt.hashSync('s3cret', 4)}\nbob:${unixcrypt.encrypt('other', '$6$saltsalt')}\ncat:$apr1$Xy12AbCd$J016AtqHNNVnJHmaiyxUC1\nold:abJnggxhB/yWI\n`)
    const htpasswd = new Htpasswd(file)
    expect(htpasswd.warnings).toHaveLength(1)
    expect(await htpasswd.check('ann', 's3cret')).toBe(true)
    expect(await htpasswd.check('ann', 'wrong')).toBe(false)
    expect(await htpasswd.check('bob', 'other')).toBe(true)
    expect(await htpasswd.check('cat', 's3cret')).toBe(true)
    expect(await htpasswd.check('old', 'anything')).toBe(false)
    expect(await htpasswd.check('ghost', 's3cret')).toBe(false)
    rmSync(dir, { recursive: true })
  })

  it('limits failed logins', () => {
    let time = 0
    const limiter = new Limiter(() => time)
    const keys = ['user:ann', 'addr:192.0.2.9']
    for (let n = 0; n < 5; n++) {
      expect(limiter.blocked(keys)).toBe(false)
      limiter.failed(keys)
    }
    expect(limiter.blocked(keys)).toBe(true)
    expect(limiter.blocked(['user:bob'])).toBe(false)
    limiter.succeeded('user:ann')
    expect(limiter.blocked(['user:ann'])).toBe(false)
    expect(limiter.blocked(['addr:192.0.2.9'])).toBe(true)
    time = 301_000
    expect(limiter.blocked(keys)).toBe(false)
  })
})

describe('the policy', () => {
  it('gives roles by name and by contact group', () => {
    const config = new RolesConfig({
      authorized_for_all_hosts: ['ann'],
      authorized_contactgroup_for_read_only: ['guests'],
      authorized_for_system_information: ['*'],
    })
    expect([...config.resolve('ann', [])]).toEqual(['all_hosts', 'system_information'])
    expect([...config.resolve('bob', ['guests'])]).toEqual(['system_information', 'read_only'])
    expect(() => new RolesConfig({ authorized_for_everything: [] })).toThrow()
    expect(() => new RolesConfig({ authorised_for_all_hosts: [] })).toThrow()
  })

  it('limits tables', () => {
    expect(access('hosts', roles()).kind).toBe('limited')
    expect(access('hosts', roles('all_hosts')).kind).toBe('all')
    expect(access('services', roles('all_hosts')).kind).toBe('all')
    expect(access('services', roles('all_services')).kind).toBe('all')
    expect(access('log', roles('all_services')).kind).toBe('limited')
    expect(access('contacts', roles('all_hosts')).kind).toBe('denied')
    expect(access('contacts', roles('configuration_information')).kind).toBe('all')
    expect(access('status', roles()).kind).toBe('denied')
    expect(access('nothing', roles('all_hosts')).kind).toBe('denied')
  })

  it('lets only filters and stats through', () => {
    expect(() => checkHeaders(['Filter: state > 0', 'Filter: name ~ web', 'Or: 2'], false, roles())).not.toThrow()
    expect(() => checkHeaders(['Filter: state = 0\nCOMMAND [1] SHUTDOWN_PROGRAM'], false, roles())).toThrow()
    expect(() => checkHeaders(['AuthUser: admin'], true, roles())).toThrow()
    expect(() => checkHeaders(['Stats: state = 0'], false, roles())).toThrow()
    expect(() => checkHeaders(['Filter: custom_variables ~ PASSWORD secret'], false, roles())).toThrow()
    expect(() => checkHeaders(['Filter: custom_variables ~ X y'], false, roles('configuration_information'))).not.toThrow()
    expect(checkHeaders(['Stats: state = 0', 'Stats: state = 1', 'StatsOr: 2', 'Stats: max last_check', 'Stats: sum state'], true, roles())).toEqual(['add', 'max', 'add'])
    expect(() => checkHeaders(['Stats: avg latency'], true, roles())).toThrow()
    expect(() => checkColumns(['name', 'check_command'], roles())).toThrow()
    expect(() => checkColumns(['name', 'state'], roles())).not.toThrow()
    expect(() => checkColumns(['name\nCOMMAND'], roles())).toThrow()
  })
})

describe('commands', () => {
  const check = (name: string, ...args: string[]) => checkCommand(name, args, 'ann', 100)

  it('are checked argument by argument, and signed by the user', () => {
    const ack = check('ACKNOWLEDGE_SVC_PROBLEM', 'web1', 'http', '2', '1', '1', 'someone else', 'on it; looking')
    expect(ack.line).toBe('[100] ACKNOWLEDGE_SVC_PROBLEM;web1;http;2;1;1;ann;on it; looking')
    expect(ack.target).toEqual({ kind: 'service', host: 'web1', service: 'http' })
    expect(isService(ack.target)).toBe(true)

    expect(() => check('ACKNOWLEDGE_SVC_PROBLEM', 'web1;x', 'http', '2', '1', '1', 'a', 'b')).toThrow()
    expect(() => check('ACKNOWLEDGE_SVC_PROBLEM', 'web1', 'http', 'two', '1', '1', 'a', 'b')).toThrow()
    expect(() => check('ACKNOWLEDGE_SVC_PROBLEM', 'web1', 'http', '2', 'yes', '1', 'a', 'b')).toThrow()
    expect(() => check('ADD_HOST_COMMENT', 'web1', '1', 'a', 'line\nSHUTDOWN_PROGRAM')).toThrow()
    expect(() => check('SHUTDOWN_PROGRAM')).toThrow()
    expect(() => check('constructor')).toThrow()
    expect(() => check('DEL_HOST_COMMENT')).toThrow()
    expect(() => checkCommand('ADD_HOST_COMMENT', ['web1', '1', 'a', 'b'], 'an;n', 1)).toThrow()

    expect(check('DEL_SVC_DOWNTIME', '7').target).toEqual({ kind: 'downtime', id: 7, service: true })
    expect(() => check('DEL_SVC_DOWNTIME', '7 OR 1')).toThrow()
    expect(check('SCHEDULE_HOST_SVC_DOWNTIME', 'web1', '10', '20', '1', '0', '0', 'x', 'work').target).toEqual({ kind: 'host', host: 'web1' })
  })
})

/** A backend that answers from a list, and remembers what it was asked. */
function fake(name: string, answers: (request: string) => unknown[][], enforces = true): Backend & { asked: string[]; sent: string[] } {
  const asked: string[] = []
  const sent: string[] = []
  return {
    name,
    asked,
    sent,
    query: async (request) => {
      asked.push(request)
      return answers(request)
    },
    command: async (line) => void sent.push(line),
    enforcesAuth: async () => enforces,
  }
}

describe('queries over backends', () => {
  it('merge, sort and cut pages', async () => {
    expect(merge(merge([], [1, 5, 5], ['add', 'min', 'max']), [2, 3, 9], ['add', 'min', 'max'])).toEqual([3, 3, 9])
    expect(compare(2, 10)).toBeLessThan(0)
    expect(compare('b', 'a')).toBeGreaterThan(0)
    expect(limits('hosts', { kind: 'all' }, 'ann')).toBe('')
    expect(limits('hosts', { kind: 'limited' }, 'ann')).toBe('AuthUser: ann\n')
    expect(limits('log', { kind: 'limited' }, 'ann')).toContain('Filter: class = 1\n')

    const a = fake('a', () => [['web2', 1], ['db1', 0]])
    const b = fake('b', () => [['app1', 2], ['web1', 0]])
    const page = await rows([a, b], 'ann', roles(), { table: 'hosts', columns: ['name', 'state'], sort: [{ column: 'name' }], offset: 1, limit: 2 })
    expect(page.rows).toEqual([
      { name: 'db1', state: 0, backend: 'a' },
      { name: 'web1', state: 0, backend: 'b' },
    ])
    expect(page.total).toBe(4)
    expect(a.asked[0]).toBe('GET hosts\nColumns: name state\nAuthUser: ann\n')
  })

  it('do not ask a backend that cannot limit a limited user', async () => {
    const open = fake('open', () => [['web1']], false)
    const limited = await rows([open], 'ann', roles(), { table: 'hosts', columns: ['name'] })
    expect(limited.rows).toEqual([])
    expect(limited.errors.open).toContain('does not limit')
    expect(open.asked).toEqual([])
    const all = await rows([open], 'ann', roles('all_hosts'), { table: 'hosts', columns: ['name'] })
    expect(all.rows).toHaveLength(1)
    expect(open.asked[0]).not.toContain('AuthUser')
  })

  it('add up grouped stats', async () => {
    const a = fake('a', () => [['web', 2, 7], ['db', 1, 3]])
    const b = fake('b', () => [['web', 5, 9]])
    const answer = await stats([a, b], 'ann', roles('all_hosts'), { table: 'services', group_by: ['host_groups'], headers: ['Stats: state = 0', 'Stats: max last_check'] })
    expect(answer.groups).toEqual([
      { key: ['db'], values: [1, 3] },
      { key: ['web'], values: [7, 9] },
    ])
    await expect(stats([a], 'ann', roles(), { table: 'status', headers: ['Stats: program_start > 0'] })).rejects.toThrow('system_information')
  })
})

describe('the HTTP side', () => {
  function site(enforces = true) {
    const backend = fake(
      'site',
      (request) => {
        if (request.startsWith('GET contactgroups')) return [['admins', ['ann']]]
        if (request.startsWith('GET contacts')) return [[request.includes('name = ann') || request.includes('name = ops') ? 1 : 0]]
        if (request.includes('AuthUser: ops') && request.includes('Stats:')) return [[request.includes('web1') ? 1 : 0]]
        if (request.startsWith('GET status')) return [['1.5.2', '1.5.1', 1]]
        return [['web1']]
      },
      enforces,
    )
    const store = new Store(':memory:')
    const app = buildApp({
      backends: [backend],
      store,
      events: new Events([]),
      roles: new RolesConfig({ authorized_contactgroup_for_all_hosts: ['admins'], authorized_for_all_host_commands: ['ann'], authorized_for_read_only: ['guest'] }),
      limiter: new Limiter(),
      cookieSecure: false,
    })
    const as = (user: string) => ({ Authorization: `Bearer ${store.newToken(user, 't').token}`, 'Content-Type': 'application/json' })
    const post = (path: string, user: string, body: unknown) => app.request(path, { method: 'POST', headers: as(user), body: JSON.stringify(body) })
    return { app, backend, store, as, post }
  }

  it('knows nobody without a login', async () => {
    const { app } = site()
    expect((await app.request('/api/v1/session')).status).toBe(401)
    expect((await app.request('/api/v1/query', { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await app.request('/api/v1/session', { headers: { Authorization: 'Bearer nh_wrong' } })).status).toBe(401)
  })

  it('asks for the CSRF value with a cookie, not with a token', async () => {
    const { app, store } = site()
    const { cookie, session } = store.newSession('ann')
    const call = (headers: Record<string, string>) =>
      app.request('/api/v1/query', { method: 'POST', headers: { Cookie: `nuthatch_session=${cookie}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ table: 'hosts', columns: ['name'] }) })
    expect((await call({})).status).toBe(403)
    expect((await call({ 'X-Nuthatch-CSRF': 'guess' })).status).toBe(403)
    expect((await call({ 'X-Nuthatch-CSRF': session.csrf })).status).toBe(200)
  })

  it('sends a command only for what the user sees, and writes it down', async () => {
    const { post, backend, store } = site()
    const comment = (host: string) => ({ backend: 'site', command: 'ADD_HOST_COMMENT', args: [host, '1', 'x', 'hello'] })
    expect((await post('/api/v1/command', 'ops', comment('web1'))).status).toBe(200)
    expect((await post('/api/v1/command', 'ops', comment('db1'))).status).toBe(403)
    expect((await post('/api/v1/command', 'ann', comment('db1'))).status).toBe(200)
    expect((await post('/api/v1/command', 'guest', comment('web1'))).status).toBe(403)
    expect((await post('/api/v1/command', 'stranger', comment('web1'))).status).toBe(403)
    expect((await post('/api/v1/command', 'ann', { backend: 'site', command: 'SHUTDOWN_PROGRAM', args: [] })).status).toBe(400)
    expect(backend.sent.map((line) => line.replace(/^\[\d+\] /, ''))).toEqual(['ADD_HOST_COMMENT;web1;1;ops;hello', 'ADD_HOST_COMMENT;db1;1;ann;hello'])
    expect(store.auditTail(10).filter((row) => row.action === 'command refused')).toHaveLength(3)
  })

  it('sends nothing for a limited user to an engine that does not limit', async () => {
    const { post, backend } = site(false)
    const comment = { backend: 'site', command: 'ADD_HOST_COMMENT', args: ['web1', '1', 'x', 'hello'] }
    expect((await post('/api/v1/command', 'ops', comment)).status).toBe(403)
    expect((await post('/api/v1/command', 'ann', comment)).status).toBe(200)
    expect(backend.sent).toHaveLength(1)
  })

  it('refuses what is not a query', async () => {
    const { post } = site()
    expect((await post('/api/v1/query', 'ann', { table: 'hosts', columns: ['name'], headers: ['AuthUser: root'] })).status).toBe(400)
    expect((await post('/api/v1/query', 'ann', { table: 'contacts', columns: ['name'] })).status).toBe(403)
    expect((await post('/api/v1/query', 'ann', ['not', 'an', 'object'])).status).toBe(400)
    expect((await post('/api/v1/nothing', 'ann', {})).status).toBe(404)
  })
})
