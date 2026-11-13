// A short history of the numbers plugins give as performance data, for
// the small graphs on a host's or service's page.
//
// While it is turned on ([graphs] in the config), each backend is asked
// once a minute for what was checked since, and each number is kept with
// the time of its check, in an SQLite file of its own beside the store,
// for some days. This is no time-series database: a site that wants
// months of history sends its performance data to one (checkd does that
// itself) and looks at it there.

import { DatabaseSync } from 'node:sqlite'
import { parsePerfdata } from '@nuthatch/api'
import type { Backend } from './backend.ts'

/** No more numbers of one check than this are kept: some plugins give hundreds. */
const LABELS = 12
/** No more points than this go into one graph; more are averaged. */
const POINTS = 240

export interface Series {
  label: string
  unit: string
  /** Time in seconds and value, oldest first. */
  points: [number, number][]
}

export class Graphs {
  private readonly db: DatabaseSync
  private readonly days: number
  private readonly ids = new Map<string, number>()

  /** `path` is a file, or `:memory:` for tests. `every` 0: nothing is asked on its own. */
  constructor(path: string, days: number, backends: Backend[], every = 60_000) {
    this.days = days
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS series (
        id INTEGER PRIMARY KEY, backend TEXT NOT NULL, host TEXT NOT NULL, service TEXT NOT NULL,
        label TEXT NOT NULL, unit TEXT NOT NULL, UNIQUE (backend, host, service, label));
      CREATE TABLE IF NOT EXISTS points (
        series INTEGER NOT NULL, time INTEGER NOT NULL, value REAL NOT NULL,
        PRIMARY KEY (series, time)) WITHOUT ROWID;`)
    if (every > 0) for (const backend of backends) void this.watch(backend, every)
  }

  private seriesId(backend: string, host: string, service: string, label: string, unit: string): number {
    const key = JSON.stringify([backend, host, service, label])
    const known = this.ids.get(key)
    if (known !== undefined) return known
    this.db
      .prepare('INSERT INTO series (backend, host, service, label, unit) VALUES (?, ?, ?, ?, ?) ON CONFLICT (backend, host, service, label) DO UPDATE SET unit = excluded.unit')
      .run(backend, host, service, label, unit)
    const row = this.db.prepare('SELECT id FROM series WHERE backend = ? AND host = ? AND service = ? AND label = ?').get(backend, host, service, label) as { id: number }
    this.ids.set(key, row.id)
    return row.id
  }

  /** Keeps the numbers of one check. */
  record(backend: string, host: string, service: string, time: number, perfData: string): void {
    if (!time || perfData === '') return
    const insert = this.db.prepare('INSERT OR IGNORE INTO points (series, time, value) VALUES (?, ?, ?)')
    for (const perf of parsePerfdata(perfData).slice(0, LABELS)) {
      if (!Number.isFinite(perf.value) || perf.label.length > 200) continue
      insert.run(this.seriesId(backend, host, service, perf.label, perf.unit.slice(0, 16)), time, perf.value)
    }
  }

  /** Asks a backend for what was checked since, and keeps it. The newest check seen. */
  async sample(backend: Backend, since: number): Promise<number> {
    let latest = since
    const tables: [string, string][] = [
      ['hosts', 'name'],
      ['services', 'host_name description'],
    ]
    for (const [table, names] of tables) {
      const rows = await backend.query(`GET ${table}\nColumns: ${names} last_check perf_data\nFilter: last_check > ${since}\nFilter: perf_data != `)
      this.db.exec('BEGIN')
      try {
        for (const row of rows) {
          const [host, second, third, fourth] = row as [string, unknown, unknown, unknown]
          const [service, time, perf] = table === 'hosts' ? ['', Number(second), String(third)] : [String(second), Number(third), String(fourth)]
          this.record(backend.name, String(host), service, time, perf)
          latest = Math.max(latest, time)
        }
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
    return latest
  }

  /** Takes out what is older than the days kept, and series left with nothing. */
  prune(now = Date.now() / 1000): void {
    this.db.prepare('DELETE FROM points WHERE time < ?').run(Math.floor(now - this.days * 86400))
    this.db.exec('DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series FROM points)')
    this.ids.clear()
  }

  /** The graphs of a host (`service` empty) or a service, over the last `hours`. */
  series(backend: string, host: string, service: string, hours: number, now = Date.now() / 1000): Series[] {
    const from = Math.floor(now - hours * 3600)
    const found = this.db.prepare('SELECT id, label, unit FROM series WHERE backend = ? AND host = ? AND service = ? ORDER BY id').all(backend, host, service) as {
      id: number
      label: string
      unit: string
    }[]
    const out: Series[] = []
    for (const s of found) {
      const rows = this.db.prepare('SELECT time, value FROM points WHERE series = ? AND time >= ? ORDER BY time').all(s.id, from) as { time: number; value: number }[]
      if (rows.length === 0) continue
      out.push({ label: s.label, unit: s.unit, points: thin(rows.map((r) => [r.time, r.value])) })
    }
    return out
  }

  private async watch(backend: Backend, every: number): Promise<void> {
    // From a little back, so that a restart loses nothing of the last checks.
    let since = Math.floor(Date.now() / 1000) - 600
    let pruned = 0
    for (;;) {
      since = await this.sample(backend, since).catch(() => since)
      if (Date.now() - pruned > 3_600_000) {
        pruned = Date.now()
        try {
          this.prune()
        } catch {
          // Next hour.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, every).unref())
    }
  }
}

/** At most POINTS points: more are averaged over equal spans of time. */
export function thin(points: [number, number][], most = POINTS): [number, number][] {
  if (points.length <= most) return points
  const first = points[0]?.[0] ?? 0
  const span = ((points[points.length - 1]?.[0] ?? first) - first) / most || 1
  const out: [number, number][] = []
  let bucket = 0
  let sum = 0
  let time = 0
  let n = 0
  for (const [t, v] of points) {
    const at = Math.min(most - 1, Math.floor((t - first) / span))
    if (at !== bucket && n > 0) {
      out.push([Math.round(time / n), sum / n])
      sum = time = n = 0
    }
    bucket = at
    sum += v
    time += t
    n++
  }
  if (n > 0) out.push([Math.round(time / n), sum / n])
  return out
}
