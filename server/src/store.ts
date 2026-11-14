// nuthatch's own store, one SQLite file: sessions, API tokens,
// preferences, dashboards, the audit log, and what agents said their
// hosts are (their inventories). What is monitored, and how, stays with
// the engines and their config files.
//
// Session and token secrets are kept as SHA-256 hashes, so a copy of the
// file does not log anyone in.

import { createHash, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export function now(): number {
  return Math.floor(Date.now() / 1000)
}

/** A new secret: 32 random bytes, in hex. */
export function secret(): string {
  return randomBytes(32).toString('hex')
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** How long a session lasts without being used, and at most. */
const IDLE = 8 * 3600
const LONGEST = 7 * 24 * 3600

export interface Session {
  user: string
  csrf: string
}

export interface TokenInfo {
  id: number
  name: string
  created: number
  last_used: number | null
}

export interface DashboardRow {
  id: number
  owner: string
  title: string
  shared: number
  /** JSON: the range, the host chooser and the panels. */
  body: string
  updated: number
}

export interface PushRow {
  endpoint: string
  user: string
  p256dh: string
  auth: string
  name: string
  created: number
}

export interface InventoryRow {
  body: string
  received: number
  /** Keys of the base checks added. */
  base: string[]
  /** Keys of proposals set aside. */
  dismissed: string[]
}

export interface AuditRow {
  time: number
  user: string
  backend: string
  action: string
  detail: string
}

export class Store {
  private readonly db: DatabaseSync

  /** `path` is a file, or `:memory:` for tests. */
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, user TEXT NOT NULL, csrf TEXT NOT NULL,
        created INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user TEXT NOT NULL,
        name TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER);
      CREATE TABLE IF NOT EXISTS prefs (
        user TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (user, key));
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, time INTEGER NOT NULL, user TEXT NOT NULL,
        backend TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_time ON audit (time);
      CREATE TABLE IF NOT EXISTS dashboards (
        id INTEGER PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
        shared INTEGER NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push (
        endpoint TEXT PRIMARY KEY, user TEXT NOT NULL, p256dh TEXT NOT NULL,
        auth TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS push_user ON push (user);
      CREATE TABLE IF NOT EXISTS inventories (
        backend TEXT NOT NULL, host TEXT NOT NULL, body TEXT NOT NULL,
        received INTEGER NOT NULL, base TEXT NOT NULL, dismissed TEXT NOT NULL,
        PRIMARY KEY (backend, host));`)
  }

  /** Starts a session. The answer is the cookie's secret and the session. */
  newSession(user: string): { cookie: string; session: Session } {
    const cookie = secret()
    const csrf = secret()
    const t = now()
    this.db.prepare('DELETE FROM sessions WHERE last_seen < ? OR created < ?').run(t - IDLE, t - LONGEST)
    this.db.prepare('INSERT INTO sessions (hash, user, csrf, created, last_seen) VALUES (?, ?, ?, ?, ?)').run(hash(cookie), user, csrf, t, t)
    return { cookie, session: { user, csrf } }
  }

  session(cookie: string): Session | null {
    const t = now()
    const h = hash(cookie)
    const row = this.db
      .prepare('SELECT user, csrf FROM sessions WHERE hash = ? AND last_seen >= ? AND created >= ?')
      .get(h, t - IDLE, t - LONGEST) as { user: string; csrf: string } | undefined
    if (!row) return null
    this.db.prepare('UPDATE sessions SET last_seen = ? WHERE hash = ? AND last_seen < ?').run(t, h, t - 60)
    return { user: row.user, csrf: row.csrf }
  }

  endSession(cookie: string): void {
    this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash(cookie))
  }

  /** Makes an API token for a user. The secret is given once, here. */
  newToken(user: string, name: string): { id: number; token: string } {
    const token = `nh_${secret()}`
    const made = this.db.prepare('INSERT INTO tokens (hash, user, name, created) VALUES (?, ?, ?, ?)').run(hash(token), user, name, now())
    return { id: Number(made.lastInsertRowid), token }
  }

  /** The user a token belongs to. */
  tokenUser(token: string): string | null {
    const h = hash(token)
    const row = this.db.prepare('SELECT user FROM tokens WHERE hash = ?').get(h) as { user: string } | undefined
    if (!row) return null
    this.db.prepare('UPDATE tokens SET last_used = ? WHERE hash = ?').run(now(), h)
    return row.user
  }

  tokens(user: string): TokenInfo[] {
    const rows = this.db.prepare('SELECT id, name, created, last_used FROM tokens WHERE user = ? ORDER BY id').all(user)
    return rows.map((row) => ({ ...row }) as unknown as TokenInfo)
  }

  deleteToken(user: string, id: number): boolean {
    return this.db.prepare('DELETE FROM tokens WHERE id = ? AND user = ?').run(id, user).changes > 0
  }

  pref(user: string, key: string): string | null {
    const row = this.db.prepare('SELECT value FROM prefs WHERE user = ? AND key = ?').get(user, key) as { value: string } | undefined
    return row?.value ?? null
  }

  setPref(user: string, key: string, value: string): void {
    this.db
      .prepare('INSERT INTO prefs (user, key, value) VALUES (?, ?, ?) ON CONFLICT (user, key) DO UPDATE SET value = excluded.value')
      .run(user, key, value)
  }

  /** A browser to push notifications to; one that was another user's becomes this one's. */
  addPush(user: string, sub: { endpoint: string; p256dh: string; auth: string }, name: string): void {
    this.db
      .prepare(
        'INSERT INTO push (endpoint, user, p256dh, auth, name, created) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT (endpoint) DO UPDATE SET user = excluded.user, p256dh = excluded.p256dh, auth = excluded.auth, name = excluded.name',
      )
      .run(sub.endpoint, user, sub.p256dh, sub.auth, name, now())
  }

  /** Forgets a browser: a user's own, or, without a user, whoever's. */
  removePush(endpoint: string, user?: string): boolean {
    return user === undefined
      ? this.db.prepare('DELETE FROM push WHERE endpoint = ?').run(endpoint).changes > 0
      : this.db.prepare('DELETE FROM push WHERE endpoint = ? AND user = ?').run(endpoint, user).changes > 0
  }

  pushOf(user: string): PushRow[] {
    return this.db.prepare('SELECT endpoint, user, p256dh, auth, name, created FROM push WHERE user = ? ORDER BY created').all(user) as unknown as PushRow[]
  }

  /** Whether anyone is to be pushed to at all. */
  anyPush(): boolean {
    return this.db.prepare('SELECT 1 FROM push LIMIT 1').get() !== undefined
  }

  /** A user's own dashboards and the shared ones, by title. */
  dashboards(user: string): DashboardRow[] {
    const rows = this.db.prepare('SELECT id, owner, title, shared, body, updated FROM dashboards WHERE owner = ? OR shared = 1 ORDER BY title, id').all(user)
    return rows.map((row) => ({ ...row }) as unknown as DashboardRow)
  }

  /** One dashboard, when it is the user's or shared. */
  dashboard(user: string, id: number): DashboardRow | null {
    const row = this.db.prepare('SELECT id, owner, title, shared, body, updated FROM dashboards WHERE id = ? AND (owner = ? OR shared = 1)').get(id, user)
    return row ? ({ ...row } as unknown as DashboardRow) : null
  }

  newDashboard(owner: string, title: string, shared: boolean, body: string): number {
    const made = this.db.prepare('INSERT INTO dashboards (owner, title, shared, body, updated) VALUES (?, ?, ?, ?, ?)').run(owner, title, shared ? 1 : 0, body, now())
    return Number(made.lastInsertRowid)
  }

  /** Changes a dashboard: the user's own, or a shared one, which stays shared. */
  saveDashboard(user: string, id: number, title: string, shared: boolean, body: string): boolean {
    return (
      this.db
        .prepare('UPDATE dashboards SET title = ?, shared = CASE WHEN owner = ? THEN ? ELSE 1 END, body = ?, updated = ? WHERE id = ? AND (owner = ? OR shared = 1)')
        .run(title, user, shared ? 1 : 0, body, now(), id, user).changes > 0
    )
  }

  deleteDashboard(owner: string, id: number): boolean {
    return this.db.prepare('DELETE FROM dashboards WHERE id = ? AND owner = ?').run(id, owner).changes > 0
  }

  inventory(backend: string, host: string): InventoryRow | undefined {
    const row = this.db.prepare('SELECT body, received, base, dismissed FROM inventories WHERE backend = ? AND host = ?').get(backend, host) as
      | { body: string; received: number; base: string; dismissed: string }
      | undefined
    return row && { body: row.body, received: row.received, base: JSON.parse(row.base) as string[], dismissed: JSON.parse(row.dismissed) as string[] }
  }

  /** Keeps what an agent said; what was decided of it before stays. */
  keepInventory(backend: string, host: string, body: string, received: number): void {
    this.db
      .prepare(`INSERT INTO inventories (backend, host, body, received, base, dismissed) VALUES (?, ?, ?, ?, '[]', '[]')
        ON CONFLICT (backend, host) DO UPDATE SET body = excluded.body, received = excluded.received`)
      .run(backend, host, body, received)
  }

  /** The base checks added to a host, so that they are added once. */
  setInventoryBase(backend: string, host: string, base: string[]): void {
    this.db.prepare('UPDATE inventories SET base = ? WHERE backend = ? AND host = ?').run(JSON.stringify(base), backend, host)
  }

  dismissProposals(backend: string, host: string, keys: string[]): void {
    const row = this.inventory(backend, host)
    if (!row) return
    const all = [...new Set([...row.dismissed, ...keys])].slice(-1000)
    this.db.prepare('UPDATE inventories SET dismissed = ? WHERE backend = ? AND host = ?').run(JSON.stringify(all), backend, host)
  }

  forgetInventory(backend: string, host: string): void {
    this.db.prepare('DELETE FROM inventories WHERE backend = ? AND host = ?').run(backend, host)
  }

  /** Writes down what somebody did: logins, commands, refusals. */
  audit(user: string, backend: string, action: string, detail: string): void {
    this.db.prepare('INSERT INTO audit (time, user, backend, action, detail) VALUES (?, ?, ?, ?, ?)').run(now(), user, backend, action, detail)
  }

  auditTail(limit: number): AuditRow[] {
    const rows = this.db.prepare('SELECT time, user, backend, action, detail FROM audit ORDER BY id DESC LIMIT ?').all(limit)
    return rows.map((row) => ({ ...row }) as unknown as AuditRow)
  }
}
