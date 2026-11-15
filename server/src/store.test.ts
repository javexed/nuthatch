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
})
