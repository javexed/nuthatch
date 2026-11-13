import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FoundPort, QueryAnswer, Role } from '@nuthatch/api'
import bcrypt from 'bcryptjs'
import * as unixcrypt from 'unixcrypt'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { Htpasswd, Limiter, tailnetUsers, verify } from './auth.ts'
import type { Backend } from './backend.ts'
import { checkCommand, isService } from './commands.ts'
import { CATALOGUE_NAMES, catalogueFile, pluginsDir } from './catalogue.ts'
import { checkHost, hostFile, readHostFile } from './configadmin.ts'
import { discover, hostName, parseTarget, suggest } from './discover.ts'
import { Events } from './events.ts'
import { PathMap, mainWith, parseObjects, templates, writeObjects } from './nagioscfg.ts'
import { RolesConfig, access, checkColumns, checkHeaders } from './policy.ts'
import { compare, limits, merge, rows, stats } from './query.ts'
import { RemoteSite } from './remote.ts'
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

  it('lets a listed tailnet login in without a password, through a session of its own', async () => {
    const backend = fake('site', (request) => (request.startsWith('GET status') ? [['1.5.2', '1.5.1', 1]] : [['web1']]))
    const store = new Store(':memory:')
    const app = buildApp({
      backends: [backend],
      store,
      events: new Events([]),
      roles: new RolesConfig({ authorized_for_all_hosts: ['ann', 'bob'] }),
      limiter: new Limiter(),
      cookieSecure: true,
      tailscaleUsers: tailnetUsers({ users: { 'Ann@Example.test': 'ann', 'bob@example.test': 'bob' } }),
    })
    const tailnet = (login: string, more: Record<string, string> = {}) => ({ 'Tailscale-User-Login': login, ...more })
    const cookieOf = (response: Response) => response.headers.get('set-cookie')?.match(/nuthatch_session=([^;]*)/)?.[1] ?? ''

    // A listed login, in any case, gets a session: its cookie and CSRF value.
    const first = await app.request('/api/v1/session', { headers: tailnet('ann@example.test') })
    expect(first.status).toBe(200)
    const session = (await first.json()) as { user: string; csrf: string; by_tailnet: boolean }
    expect(session).toMatchObject({ user: 'ann', by_tailnet: true })
    expect(first.headers.get('set-cookie')).toContain('Secure')
    const cookie = cookieOf(first)
    expect(store.session(cookie)?.user).toBe('ann')

    // What changes things still needs the CSRF value: a page of another
    // site cannot send it, though the tailnet identity comes along.
    const query = (headers: Record<string, string>) =>
      app.request('/api/v1/query', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ table: 'hosts', columns: ['name'] }) })
    expect((await query(tailnet('ann@example.test'))).status).toBe(403)
    expect((await query(tailnet('ann@example.test', { Cookie: `nuthatch_session=${cookie}` }))).status).toBe(403)
    const ok = await query(tailnet('ann@example.test', { Cookie: `nuthatch_session=${cookie}`, 'X-Nuthatch-CSRF': session.csrf }))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('set-cookie')).toBeNull()

    // Someone else on the same browser: ann's session ends, bob's begins.
    const other = await app.request('/api/v1/session', { headers: tailnet('bob@example.test', { Cookie: `nuthatch_session=${cookie}` }) })
    expect(((await other.json()) as { user: string }).user).toBe('bob')
    expect(store.session(cookie)).toBeNull()

    // An unlisted login, or none, is asked to log in as before.
    expect((await app.request('/api/v1/session', { headers: tailnet('eve@example.test') })).status).toBe(401)
    expect((await app.request('/api/v1/session', { headers: tailnet('') })).status).toBe(401)
    // A password session is not by the tailnet.
    const { cookie: byPassword } = store.newSession('ann')
    const plain = await app.request('/api/v1/session', { headers: { Cookie: `nuthatch_session=${byPassword}` } })
    expect(((await plain.json()) as { by_tailnet: boolean }).by_tailnet).toBe(false)
    // A token says who it is for, whatever the tailnet says.
    const token = store.newToken('bob', 'phone').token
    const byToken = await app.request('/api/v1/session', { headers: tailnet('ann@example.test', { Authorization: `Bearer ${token}` }) })
    expect(((await byToken.json()) as { user: string }).user).toBe('bob')
  })

  it('reads the [tailscale] table strictly', () => {
    expect(tailnetUsers({ users: { 'A@x.test': 'ann' } }).get('a@x.test')).toBe('ann')
    expect(() => tailnetUsers({ users: { 'a@x.test': 'ann' }, trust_all: true })).toThrow(/no setting trust_all/)
    expect(() => tailnetUsers({ users: ['a@x.test'] })).toThrow(/table of tailnet logins/)
    expect(() => tailnetUsers({ users: { 'a b': 'ann' } })).toThrow(/no tailnet login/)
    expect(() => tailnetUsers({ users: { 'a@x.test': 'ann;x' } })).toThrow(/user's name/)
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


describe('object files', () => {
  it('are read definition by definition', () => {
    const definitions = parseObjects('# top\ndefine host {\n  host_name web1 ; the name\n  alias   A  host\n}\ndefine service{\nuse x\n}\n')
    expect(definitions).toEqual([
      { type: 'host', attrs: [['host_name', 'web1'], ['alias', 'A  host']] },
      { type: 'service', attrs: [['use', 'x']] },
    ])
    expect(writeObjects(definitions.slice(0, 1), 'by a test')).toBe('# by a test\ndefine host {\n    host_name  web1\n    alias      A  host\n}\n')
  })

  it('map paths of an engine in a container, and lead a main config to a copy', () => {
    const paths = new PathMap({ '/site': '/home/x/dev' })
    expect(paths.toLocal('/site/objects.cfg')).toBe('/home/x/dev/objects.cfg')
    expect(paths.toEngine('/home/x/dev/run/a')).toBe('/site/run/a')
    expect(paths.toLocal('/sitemap')).toBe('/sitemap')
    const main = { lines: ['cfg_file=objects.cfg', 'cfg_dir=/etc/n/managed/', 'log_file=x.log', 'resource_file = r.cfg'], engineDir: '/etc/n', files: [], dirs: [] }
    expect(mainWith(main, '/etc/n/managed', '/tmp/copy').split('\n')).toEqual(['cfg_file=/etc/n/objects.cfg', 'cfg_dir=/tmp/copy', 'log_file=x.log', 'resource_file = /etc/n/r.cfg'])
  })

  it('finds templates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuthatch-cfg-'))
    writeFileSync(join(dir, 'a.cfg'), 'define host {\n name generic-host\n register 0\n}\ndefine host {\n host_name real\n}\ndefine service {\n name generic-service\n register 0\n}\n')
    expect(templates([join(dir, 'a.cfg'), join(dir, 'missing.cfg')], 'host')).toEqual(['generic-host'])
    expect(templates([join(dir, 'a.cfg')], 'service')).toEqual(['generic-service'])
    rmSync(dir, { recursive: true })
  })
})

describe('a host to write', () => {
  const choices = { commands: ['check_ping'], contacts: ['ann'], contactgroups: ['admins'], hostgroups: ['web'], servicegroups: [] }
  const known = { host: ['generic-host'], service: ['generic-service'] }
  const host = {
    name: 'web9',
    address: '192.0.2.9',
    use: 'generic-host',
    hostgroups: ['web'],
    contacts: [],
    contact_groups: ['admins'],
    services: [{ description: 'ping', use: 'generic-service', check_command: 'check_ping!100,20%!500,60%', servicegroups: [], contacts: ['ann'], contact_groups: [] }],
  }

  it('goes into a file and comes back the same', () => {
    const checked = checkHost(host, choices, known)
    const text = hostFile(checked)
    expect(text).toContain('define host {\n    host_name       web9\n    use             generic-host\n')
    expect(text).toContain('    check_command        check_ping!100,20%!500,60%\n')
    expect(readHostFile(text)).toEqual(JSON.parse(JSON.stringify(checked)))
  })

  it('cannot carry a definition of its own, or what the engine has not', () => {
    const bad = (change: Record<string, unknown>) => () => checkHost({ ...host, ...change }, choices, known)
    expect(bad({ alias: 'x\n}\ndefine command {' })).toThrow()
    expect(bad({ notes: 'a ; b' })).toThrow()
    expect(bad({ name: '../etc' })).toThrow()
    expect(bad({ name: 'a b' })).toThrow()
    expect(bad({ address: '192.0.2.9 extra' })).toThrow()
    expect(bad({ use: 'other' })).toThrow()
    expect(bad({ check_command: 'rm!-rf' })).toThrow()
    expect(bad({ hostgroups: ['web,db'] })).toThrow()
    expect(bad({ contacts: ['nobody'] })).toThrow()
    expect(bad({ services: [{ ...host.services[0], description: 'x\ny' }] })).toThrow()
    expect(bad({ services: [host.services[0], host.services[0]] })).toThrow()
  })

  it('is left alone when a hand changed its file beyond what is edited', () => {
    expect(() => readHostFile('define host {\n host_name a\n use t\n address x\n max_check_attempts 9\n}\n')).toThrow('max_check_attempts')
    expect(() => readHostFile('define host {\n host_name a\n}\ndefine host {\n host_name b\n}\n')).toThrow('exactly one host')
    expect(() => readHostFile('define host {\n host_name a\n}\ndefine service {\n host_name b\n service_description s\n}\n')).toThrow('another host')
  })
})

describe('dashboards', () => {
  it('are the owner\'s to change, and everyone\'s to see when shared', async () => {
    const store = new Store(':memory:')
    const app = buildApp({ backends: [], store, events: new Events([]), roles: new RolesConfig(), limiter: new Limiter(), cookieSecure: false })
    const call = (user: string, method: string, path: string, body?: unknown) =>
      app.request(path, { method, headers: { Authorization: `Bearer ${store.newToken(user, 't').token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const draft = { title: 'Mine', shared: false, widgets: [{ type: 'totals', of: 'hosts', extra: 'dropped' }, { type: 'object', backend: 'a', host: 'web1' }] }
    const made = (await (await call('ann', 'POST', '/api/v1/dashboards', draft)).json()) as { id: number; widgets: unknown[]; owner: string }
    expect(made.owner).toBe('ann')
    expect(made.widgets[0]).toEqual({ type: 'totals', of: 'hosts' })

    expect((await call('bob', 'GET', `/api/v1/dashboards/${made.id}`)).status).toBe(404)
    expect(await (await call('bob', 'GET', '/api/v1/dashboards')).json()).toEqual([])
    expect((await call('ann', 'PUT', `/api/v1/dashboards/${made.id}`, { ...draft, shared: true })).status).toBe(200)
    expect((await call('bob', 'GET', `/api/v1/dashboards/${made.id}`)).status).toBe(200)
    expect((await call('bob', 'PUT', `/api/v1/dashboards/${made.id}`, draft)).status).toBe(404)
    expect((await call('bob', 'DELETE', `/api/v1/dashboards/${made.id}`)).status).toBe(404)

    expect((await call('ann', 'POST', '/api/v1/dashboards', { title: 'x', widgets: [{ type: 'script' }] })).status).toBe(400)
    expect((await call('ann', 'POST', '/api/v1/dashboards', { title: '', widgets: [] })).status).toBe(400)
    expect((await call('ann', 'POST', '/api/v1/dashboards', { title: 'x', widgets: [{ type: 'problems', of: 'services', limit: 100000 }] })).status).toBe(400)
    expect((await call('ann', 'DELETE', `/api/v1/dashboards/${made.id}`)).status).toBe(200)
  })
})

describe('one nuthatch over the nuthatch of a site', () => {
  const KEY = 'k'.repeat(40)
  const hashOf = (key: string) => createHash('sha256').update(key).digest('hex')

  /** A site with one engine, and a central nuthatch with an engine of its own that asks the site with `key`. */
  function pair(peer: { readOnly?: boolean; config?: boolean } = {}, key = KEY) {
    const engine = (name: string, hosts: string[]) =>
      fake(name, (request) => {
        if (request.startsWith('GET contactgroups')) return [['admins', ['ann']]]
        if (request.startsWith('GET contacts')) return [[1]]
        if (request.startsWith('GET status')) return [['1.5.2', '1.5.1', 1]]
        if (request.includes('Stats:') && request.includes('AuthUser: ops')) return [[request.includes('name = web1') ? 1 : 0]]
        if (request.includes('Stats:')) return [[hosts.length]]
        // ops is a contact of web1 only.
        return hosts.filter((h) => !request.includes('AuthUser: ops') || h === 'web1').map((h) => [h, h.length])
      })
    const roles = () => new RolesConfig({ authorized_contactgroup_for_all_hosts: ['admins'], authorized_for_all_host_commands: ['ann'] })
    const siteEngine = engine('only', ['web1', 'far1'])
    const siteStore = new Store(':memory:')
    const site = buildApp({
      backends: [siteEngine],
      store: siteStore,
      events: new Events([]),
      roles: roles(),
      limiter: new Limiter(),
      cookieSecure: false,
      peers: [{ name: 'central', keyHash: hashOf(KEY), readOnly: peer.readOnly === true, config: peer.config === true }],
    })
    const toSite = ((input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace('https://site.example.test', '')
      // The stream of events is not part of these tests.
      if (path === '/api/v1/events') return new Promise<Response>(() => undefined)
      return Promise.resolve(site.request(path, init))
    }) as typeof fetch
    const store = new Store(':memory:')
    const central = buildApp({
      backends: [engine('near', ['near1', 'web1'])],
      store,
      events: new Events([]),
      roles: roles(),
      limiter: new Limiter(),
      cookieSecure: false,
      remotes: [new RemoteSite('east', 'https://site.example.test', key, toSite)],
    })
    const post = (path: string, user: string, body: unknown) =>
      central.request(path, { method: 'POST', headers: { Authorization: `Bearer ${store.newToken(user, 't').token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { central, site, siteEngine, siteStore, store, post }
  }

  it('passes looking at a host on to the site, which decides', async () => {
    // The site looks from where its engine is; the central one only passes it on.
    const asked: string[] = []
    const { post, site } = pair({ config: true })
    const original = site.request.bind(site)
    site.request = ((input: string, init?: RequestInit) => {
      asked.push(String(input))
      return original(input, init)
    }) as typeof site.request
    const answer = await post('/api/v1/config/east/discover', 'ann', { target: 'nas.example.test' })
    expect(asked).toContain('/api/v1/config/only/discover')
    // The site decides by its own roles: ann may not change its config.
    expect(((await answer.json()) as { error: string }).error).toContain('config_edit')
    // A key that may only read gets nowhere with it.
    const readOnly = pair({ readOnly: true, config: true })
    const refused = await readOnly.post('/api/v1/config/east/discover', 'ann', { target: 'nas.example.test' })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(((await refused.json()) as { error: string }).error).toMatch(/may not change the config|may only read/)
  })

  it('shows both, sorted as one, each under its name', async () => {
    const { post } = pair()
    const answer = (await (await post('/api/v1/query', 'ann', { table: 'hosts', columns: ['name', 'state'], sort: [{ column: 'name' }], offset: 1, limit: 2 })).json()) as QueryAnswer
    expect(answer.rows).toEqual([
      { name: 'near1', state: 5, backend: 'near' },
      { name: 'web1', state: 4, backend: 'east' },
    ])
    expect(answer.total).toBe(4)
    const stats = (await (await post('/api/v1/stats', 'ann', { table: 'hosts', headers: ['Stats: state >= 0'] })).json()) as { groups: { values: number[] }[]; by_backend: Record<string, unknown> }
    expect(stats.groups[0]?.values).toEqual([4])
    expect(Object.keys(stats.by_backend).sort()).toEqual(['east', 'near'])
  })

  it('leaves it to the site what a user may see and do there', async () => {
    const { post, siteEngine, siteStore, store } = pair()
    const ops = (await (await post('/api/v1/query', 'ops', { table: 'hosts', columns: ['name', 'state'], backends: ['east'] })).json()) as QueryAnswer
    expect(ops.rows.map((r) => r.name)).toEqual(['web1'])
    const comment = (host: string) => ({ backend: 'east', command: 'ADD_HOST_COMMENT', args: [host, '1', 'x', 'hello'] })
    expect((await post('/api/v1/command', 'ops', comment('web1'))).status).toBe(200)
    expect((await post('/api/v1/command', 'ops', comment('far1'))).status).toBe(403)
    expect(siteEngine.sent.map((line) => line.replace(/^\[\d+\] /, ''))).toEqual(['ADD_HOST_COMMENT;web1;1;ops;hello'])
    expect(siteStore.auditTail(5).find((row) => row.action === 'command')?.detail).toContain('(through central)')
    expect(store.auditTail(5).map((row) => row.action).sort()).toEqual(['command passed on', 'command refused'])
  })

  it('is kept to reading by a key that may only read, and out by a wrong one', async () => {
    const readOnly = pair({ readOnly: true })
    expect((await readOnly.post('/api/v1/query', 'ann', { table: 'hosts', columns: ['name'], backends: ['east'] })).status).toBe(200)
    expect((await readOnly.post('/api/v1/command', 'ann', { backend: 'east', command: 'ADD_HOST_COMMENT', args: ['web1', '1', 'x', 'y'] })).status).toBe(403)
    expect(readOnly.siteEngine.sent).toEqual([])

    const wrong = pair({}, 'w'.repeat(40))
    const answer = (await (await wrong.post('/api/v1/query', 'ann', { table: 'hosts', columns: ['name'] })).json()) as QueryAnswer
    expect(answer.rows.map((r) => r.backend)).toEqual(['near', 'near'])
    expect(answer.errors.east).toBe("the site does not take this nuthatch's key")
    // What is only this nuthatch's is not for another one.
    const direct = (path: string) => wrong.site.request(path, { headers: { Authorization: `Peer ${KEY}`, 'X-Nuthatch-User': 'ann' } })
    expect((await direct('/api/v1/session')).status).toBe(200)
    expect((await direct('/api/v1/dashboards')).status).toBe(403)
    expect((await direct('/api/v1/audit')).status).toBe(403)
    expect((await wrong.site.request('/api/v1/session', { headers: { Authorization: `Peer ${KEY}`, 'X-Nuthatch-User': 'a%0Ab' } })).status).toBe(401)
  })
})

describe('an app served from elsewhere', () => {
  it('may call with a token when its origin is listed, and logs in for one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuthatch-app-'))
    writeFileSync(join(dir, 'htpasswd'), `ann:${bcrypt.hashSync('s3cret', 4)}\n`)
    const store = new Store(':memory:')
    const app = buildApp({
      backends: [],
      store,
      events: new Events([]),
      roles: new RolesConfig(),
      limiter: new Limiter(),
      htpasswd: new Htpasswd(join(dir, 'htpasswd')),
      cookieSecure: false,
      appOrigins: ['capacitor://localhost'],
    })
    const preflight = (origin: string) => app.request('/api/v1/query', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } })
    expect((await preflight('capacitor://localhost')).headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost')
    expect((await preflight('capacitor://localhost')).headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
    expect((await preflight('https://elsewhere.example.test')).status).toBe(403)

    const login = await app.request('/api/v1/login', {
      method: 'POST',
      headers: { Origin: 'capacitor://localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'ann', password: 's3cret', token: 'my phone' }),
    })
    expect(login.headers.get('Set-Cookie')).toBeNull()
    expect(login.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost')
    const { token, id } = (await login.json()) as { token: string; id: number }
    expect(store.tokens('ann')).toMatchObject([{ id, name: 'my phone' }])
    const session = await app.request('/api/v1/session', { headers: { Authorization: `Bearer ${token}`, Origin: 'capacitor://localhost' } })
    expect(session.status).toBe(200)
    // Logging out of the app deletes its token.
    expect((await app.request(`/api/v1/tokens/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
    expect((await app.request('/api/v1/session', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
    // An origin that is not listed gets an answer its browser will not hand to the page.
    const other = await app.request('/api/v1/session', { headers: { Origin: 'https://elsewhere.example.test' } })
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull()
    rmSync(dir, { recursive: true })
  })
})

describe('looking at a host before adding it', () => {
  it('takes a name, an address or a URL, and nothing else', () => {
    expect(parseTarget('nas.example.test')).toEqual({ host: 'nas.example.test' })
    expect(parseTarget(' 192.0.2.7 ')).toEqual({ host: '192.0.2.7' })
    expect(parseTarget('https://photos.example.test/api/ping')).toEqual({ host: 'photos.example.test', url: { https: true, port: 443, path: '/api/ping' } })
    expect(parseTarget('http://192.0.2.7:8096/')).toEqual({ host: '192.0.2.7', url: { https: false, port: 8096, path: '/' } })
    for (const bad of ['', 'two words', 'nas;rm', 'ftp://x.test/', 'https://u:p@x.test/', 'https://x.test/a!b', 'https://x.test/$USER1$', 42]) {
      expect(() => parseTarget(bad)).toThrow()
    }
    expect(hostName('nas.example.test')).toBe('nas')
    expect(hostName('192.0.2.7')).toBe('192.0.2.7')
  })

  it('suggests checks for what answered, ticking what is worth watching', () => {
    const found: FoundPort[] = [
      { port: 22, service: 'SSH', kind: 'banner', banner: 'SSH-2.0-OpenSSH_9.8' },
      { port: 23, service: 'Telnet', kind: 'open' },
      { port: 80, service: 'HTTP', kind: 'web', http: { status: 301, location: 'https://nas.example.test/' } },
      { port: 443, service: 'HTTPS', kind: 'web', http: { status: 200, title: 'NAS' }, tls: { expires: '2027-01-01T00:00:00Z', days: 61, trusted: true } },
      { port: 8443, service: 'Web 8443', kind: 'web', http: { status: 200 }, tls: { expires: '2027-01-01T00:00:00Z', days: 400, trusted: false, issuer: 'self' } },
      { port: 5432, service: 'PostgreSQL', kind: 'open' },
      { port: 3000, service: 'Web 3000', kind: 'web', http: { status: 200, title: 'Grafana: the dashboards' } },
    ]
    const { host_check, suggestions } = suggest({ host: 'nas.example.test' }, found, true)
    expect(host_check).toBeUndefined()
    const table = suggestions.map((s) => [s.description, s.check_command, s.checked])
    expect(table).toEqual([
      ['SSH', 'nuthatch_ssh!22', true],
      ['Telnet', 'nuthatch_tcp!23', false],
      ['HTTP', 'nuthatch_http!80!/', false],
      ['HTTPS', 'nuthatch_https!443!/', true],
      ['Certificate', 'nuthatch_cert!443', true],
      ['Web 8443', 'nuthatch_https!8443!/', true],
      ['Certificate 8443', 'nuthatch_cert!8443', false],
      ['PostgreSQL', 'nuthatch_tcp!5432', true],
      ['Grafana', 'nuthatch_http!3000!/', true],
    ])
    // Every suggestion uses one of nuthatch's own commands, as a description may be.
    for (const s of suggestions) expect(CATALOGUE_NAMES).toContain(s.check_command.split('!')[0])
    // A host that does not answer ping is checked on its first open port.
    expect(suggest({ host: 'nas.example.test' }, found, false).host_check).toBe('nuthatch_tcp!22')
    // A URL: a check of exactly that, and of its certificate.
    const url = suggest(parseTarget('https://photos.example.test/api/ping'), [], true).suggestions
    expect(url.map((s) => s.check_command)).toEqual(['nuthatch_https!443!/api/ping', 'nuthatch_cert!443'])
    expect(url[0]?.description).toBe('HTTPS /api/ping')
  })

  it('finds a web server and its page title', async () => {
    const server = createServer((_, response) => response.end('<html><title>Hello there</title></html>'))
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo
    try {
      const seen = await discover(`http://127.0.0.1:${port}/`)
      expect(seen.address).toBe('127.0.0.1')
      expect(seen.found.find((f) => f.port === port)?.http).toMatchObject({ status: 200, title: 'Hello there' })
      expect(seen.suggestions[0]).toMatchObject({ check_command: `nuthatch_http!${port}!/`, checked: true })
    } finally {
      server.close()
    }
  }, 20_000)

  it("brings its own commands, written from nuthatch's list only", () => {
    const text = catalogueFile('/usr/lib/monitoring-plugins')
    const defined = parseObjects(text)
    expect(defined.map((d) => d.attrs[0]?.[1])).toEqual(CATALOGUE_NAMES)
    expect(text).toContain('/usr/lib/monitoring-plugins/check_ssh -H $HOSTADDRESS$ -p $ARG1$')
    expect(pluginsDir(undefined)).toBe('$USER1$')
    for (const bad of ['relative/path', '/x;y', '$USER1$/x', '/usr/lib/plugins/']) expect(() => pluginsDir(bad)).toThrow()
    // No host may take the file's name.
    const choices = { commands: ['nuthatch_ssh'], contacts: [], contactgroups: [], hostgroups: [], servicegroups: [] }
    expect(() => checkHost({ name: 'nuthatch-commands', address: 'x.test', use: 'generic-host' }, choices, { host: ['generic-host'], service: [] })).toThrow(/nuthatch's own file/)
  })
})
