import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, SCHEMA_VERSION, Store, type Step } from './store.ts'

const version = (path: string) => {
  const db = new DatabaseSync(path)
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  } finally {
    db.close()
  }
}

describe('the store file', () => {
  it('is migrated from an older version, and refused from a newer one', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nuthatch-store-')), 'nuthatch.sqlite')
    expect(SCHEMA_VERSION).toBe(1 + MIGRATIONS.length)

    // Version 1, with a dashboard in it.
    new Store(path, []).newDashboard('ops', 'Mine', false, '{"panels":[]}')
    expect(version(path)).toBe(1)

    // Two releases later: a column, and a body rewritten by code; run once.
    let ran = 0
    const steps: Step[] = [
      "ALTER TABLE dashboards ADD COLUMN note TEXT NOT NULL DEFAULT ''",
      (db) => {
        ran++
        db.prepare('UPDATE dashboards SET body = ?').run('{"panels":[],"v":3}')
      },
    ]
    const store = new Store(path, steps)
    expect(version(path)).toBe(3)
    expect(store.dashboards('ops').map((d) => d.body)).toEqual(['{"panels":[],"v":3}'])
    new Store(path, steps)
    expect(ran).toBe(1)

    // A step that fails leaves the file as it was.
    expect(() => new Store(path, [...steps, 'ALTER TABLE nowhere ADD COLUMN x TEXT'])).toThrow(/from version 3 to 4/)
    expect(version(path)).toBe(3)

    // A nuthatch one release back does not touch it.
    expect(() => new Store(path, [])).toThrow(/version 3, from a newer nuthatch/)
  })

  it('keeps the tokens of a version 1 file, as tokens that may do everything', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nuthatch-store-')), 'nuthatch.sqlite')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE tokens (
        id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user TEXT NOT NULL,
        name TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER);
      PRAGMA user_version = 1;`)
    // A token as version 1 kept it (any hash will do).
    db.prepare('INSERT INTO tokens (hash, user, name, created) VALUES (?, ?, ?, ?)').run('8c3ee5a79f6c3b8b39ee0ddb47bb7cbf0c4c39e8e5ba5ba78c7d6c56a8bd8a7e', 'ops', 'phone', 1)
    db.close()

    const store = new Store(path)
    expect(version(path)).toBe(SCHEMA_VERSION)
    expect(store.tokens('ops')).toEqual([{ id: 1, name: 'phone', created: 1, last_used: null, read_only: false }])
    const made = store.newToken('ops', 'claude', true)
    expect(store.token(made.token)).toEqual({ user: 'ops', name: 'claude', readOnly: true })
  })
})
