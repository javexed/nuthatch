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
  /** May only read the engines (POST /query, /stats, MCP), never change anything. */
  read_only: boolean
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

/** The tables, as the latest version has them. */
const SCHEMA = `
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, user TEXT NOT NULL, csrf TEXT NOT NULL,
        created INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user TEXT NOT NULL,
        name TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER,
        read_only INTEGER NOT NULL DEFAULT 0);
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
        PRIMARY KEY (backend, host));
      CREATE TABLE IF NOT EXISTS reach (
        backend TEXT NOT NULL, contact TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (backend, contact));
      CREATE TABLE IF NOT EXISTS marks (
        key TEXT PRIMARY KEY, value TEXT NOT NULL);`

/**
 * A step from version n to n + 1, at index n - 1: SQL, or a function for
 * what SQL cannot say (rewriting the JSON of dashboards). A step, once
 * released, is never changed: a change is a new step, with a test from a
 * store of the version before it. The schema is run after the steps, so
 * a new table needs no step of its own.
 */
export type Step = string | ((db: DatabaseSync) => void)
export const MIGRATIONS: readonly Step[] = [
  // 1 → 2: tokens that may only read (for MCP clients and the like).
  'ALTER TABLE tokens ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0',
]

/** The version of the file: 1 + the number of steps. */
export const SCHEMA_VERSION = 1 + MIGRATIONS.length

/**
 * Makes the tables of a new file, or brings an older one up to date in one
 * transaction. A file from a newer nuthatch is refused. The version is
 * SQLite's `user_version`; 0 is a new file.
 */
export function prepare(db: DatabaseSync, steps: readonly Step[] = MIGRATIONS): void {
  const current = 1 + steps.length
  const found = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  if (found > current) throw new Error(`the store is of version ${found}, from a newer nuthatch; this nuthatch knows version ${current}`)
  if (found > 0 && found < current) {
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const step of steps.slice(found - 1)) {
        if (typeof step === 'string') db.exec(step)
        else step(db)
      }
      db.exec(`PRAGMA user_version = ${current}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`migrating the store from version ${found} to ${current}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  db.exec(SCHEMA)
  if (found === 0) db.exec(`PRAGMA user_version = ${current}`)
}

export class Store {
  private readonly db: DatabaseSync

  /** `path` is a file, or `:memory:` for tests. */
  constructor(path: string, steps: readonly Step[] = MIGRATIONS) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    prepare(this.db, steps)
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
  newToken(user: string, name: string, readOnly = false): { id: number; token: string } {
    const token = `nh_${secret()}`
    const made = this.db.prepare('INSERT INTO tokens (hash, user, name, created, read_only) VALUES (?, ?, ?, ?, ?)').run(hash(token), user, name, now(), readOnly ? 1 : 0)
    return { id: Number(made.lastInsertRowid), token }
  }

  /** Whose a token is, its name, and whether it may only read. */
  token(token: string): { user: string; name: string; readOnly: boolean } | null {
    const h = hash(token)
    const row = this.db.prepare('SELECT user, name, read_only FROM tokens WHERE hash = ?').get(h) as { user: string; name: string; read_only: number } | undefined
    if (!row) return null
    this.db.prepare('UPDATE tokens SET last_used = ? WHERE hash = ?').run(now(), h)
    return { user: row.user, name: row.name, readOnly: row.read_only === 1 }
  }

  /** The user a token belongs to. */
  tokenUser(token: string): string | null {
    return this.token(token)?.user ?? null
  }

  tokens(user: string): TokenInfo[] {
    const rows = this.db.prepare('SELECT id, name, created, last_used, read_only FROM tokens WHERE user = ? ORDER BY id').all(user) as Record<string, unknown>[]
    return rows.map(({ read_only, ...row }) => ({ ...row, read_only: read_only === 1 }) as unknown as TokenInfo)
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

  /** How a contact is reached besides the browsers (delivery.ts): JSON. */
  reachOf(backend: string, contact: string): string | null {
    const row = this.db.prepare('SELECT body FROM reach WHERE backend = ? AND contact = ?').get(backend, contact) as { body: string } | undefined
    return row?.body ?? null
  }

  reachAll(backend: string): Map<string, string> {
    const rows = this.db.prepare('SELECT contact, body FROM reach WHERE backend = ?').all(backend) as { contact: string; body: string }[]
    return new Map(rows.map((r) => [r.contact, r.body]))
  }

  /** `body` null: the contact is reached no other way. */
  setReach(backend: string, contact: string, body: string | null): void {
    if (body === null) this.db.prepare('DELETE FROM reach WHERE backend = ? AND contact = ?').run(backend, contact)
    else this.db.prepare('INSERT INTO reach (backend, contact, body) VALUES (?, ?, ?) ON CONFLICT (backend, contact) DO UPDATE SET body = excluded.body').run(backend, contact, body)
  }

  anyReach(): boolean {
    return this.db.prepare('SELECT 1 FROM reach LIMIT 1').get() !== undefined
  }

  /** Where nuthatch got to with something, kept across a restart: JSON. */
  mark(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM marks WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  /** `value` null: forgotten. */
  setMark(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM marks WHERE key = ?').run(key)
    else this.db.prepare('INSERT INTO marks (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
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

  /** Whether an MCP call was ever written down. */
  usedMcp(): boolean {
    return this.db.prepare("SELECT 1 FROM audit WHERE action = 'mcp' LIMIT 1").get() !== undefined
  }

  auditTail(limit: number): AuditRow[] {
    const rows = this.db.prepare('SELECT time, user, backend, action, detail FROM audit ORDER BY id DESC LIMIT ?').all(limit)
    return rows.map((row) => ({ ...row }) as unknown as AuditRow)
  }
}
