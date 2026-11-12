// nuthatch's own store, one SQLite file: sessions, API tokens,
// preferences and the audit log. Nothing about what is monitored is kept
// here; that stays with the engines and their config files.
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
      CREATE INDEX IF NOT EXISTS audit_time ON audit (time);`)
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

  /** Writes down what somebody did: logins, commands, refusals. */
  audit(user: string, backend: string, action: string, detail: string): void {
    this.db.prepare('INSERT INTO audit (time, user, backend, action, detail) VALUES (?, ?, ?, ?, ?)').run(now(), user, backend, action, detail)
  }

  auditTail(limit: number): AuditRow[] {
    const rows = this.db.prepare('SELECT time, user, backend, action, detail FROM audit ORDER BY id DESC LIMIT ?').all(limit)
    return rows.map((row) => ({ ...row }) as unknown as AuditRow)
  }
}
