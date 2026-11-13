import { describe, expect, it } from 'vitest'
import { availabilityRequest, percent, showPercent, toCsv } from './availability.ts'
import { acknowledge, downtime, recheck } from './commands.ts'
import { EMPTY, fromQuery, literal, toHeaders, toQuery } from './filters.ts'
import { ago, duration, fromInput, toInput } from './format.ts'
import { fraction, parsePerfdata } from './perfdata.ts'
import { stateOf } from './states.ts'
import { decide, latestBuild } from './update.ts'

describe('formatting', () => {
  it('writes durations with their two largest units', () => {
    expect(duration(5)).toBe('5s')
    expect(duration(0)).toBe('0s')
    expect(duration(312)).toBe('5m 12s')
    expect(duration(3600)).toBe('1h')
    expect(duration(273600 + 59)).toBe('3d 4h')
    expect(ago(0)).toBe('never')
    expect(ago(100, 160)).toBe('1m ago')
    expect(ago(200, 100)).toBe('in 1m 40s')
  })

  it('goes to a datetime input and back', () => {
    const moment = Math.floor(new Date(2026, 10, 12, 9, 30).getTime() / 1000)
    expect(toInput(moment)).toBe('2026-11-12T09:30')
    expect(fromInput('2026-11-12T09:30')).toBe(moment)
  })
})

describe('states', () => {
  it('are pending until checked', () => {
    expect(stateOf('service', 2).label).toBe('Critical')
    expect(stateOf('host', 1).tone).toBe('critical')
    expect(stateOf('host', 0, 0).label).toBe('Pending')
  })
})

describe('filters', () => {
  it('become Livestatus filter lines', () => {
    expect(toHeaders('host', EMPTY)).toEqual([])
    expect(toHeaders('service', { ...EMPTY, states: [1, 2] })).toEqual(['Filter: state = 1', 'Filter: state = 2', 'Or: 2'])
    expect(toHeaders('host', { ...EMPTY, states: [3, 1] })).toEqual(['Filter: state = 1'])
    expect(toHeaders('service', { ...EMPTY, search: ' a.b ' })).toEqual([
      'Filter: host_name ~~ a\\.b',
      'Filter: description ~~ a\\.b',
      'Filter: plugin_output ~~ a\\.b',
      'Or: 3',
    ])
    expect(toHeaders('service', { ...EMPTY, unhandled: true, host: 'web1', hostgroup: 'web' })).toEqual([
      'Filter: acknowledged = 0',
      'Filter: scheduled_downtime_depth = 0',
      'Filter: host_acknowledged = 0',
      'Filter: host_scheduled_downtime_depth = 0',
      'Filter: host_name = web1',
      'Filter: host_groups >= web',
    ])
    // Nothing a user types can start a second line.
    expect(toHeaders('host', { ...EMPTY, search: 'x\nCOMMAND', group: 'a\nb' }).every((line) => !line.includes('\n'))).toBe(true)
    expect(literal('a+b(c)')).toBe('a\\+b\\(c\\)')
  })

  it('go to a page address and back', () => {
    const filter = { ...EMPTY, states: [2, 1], search: 'disk', unhandled: true, group: 'web' }
    expect(toQuery(filter)).toEqual({ state: '1,2', q: 'disk', unhandled: '1', group: 'web' })
    expect(fromQuery(toQuery(filter))).toEqual({ ...filter, states: [1, 2] })
    expect(fromQuery({ state: 'x,9,22', q: ['a'] })).toEqual({ ...EMPTY, states: [9] })
    expect(toQuery(EMPTY)).toEqual({})
  })
})

describe('performance data', () => {
  it('is read by the plugin guidelines', () => {
    const perf = parsePerfdata("time=0.5s;1;2;0;10 'disk use'=91%;80;90 size=3B;;;0 junk=x bad")
    expect(perf.map((p) => p.label)).toEqual(['time', 'disk use', 'size'])
    expect(perf[0]).toEqual({ label: 'time', value: 0.5, unit: 's', warn: '1', crit: '2', min: 0, max: 10 })
    expect(fraction(perf[0]!)).toBe(0.05)
    expect(fraction(perf[1]!)).toBe(0.91)
    expect(fraction(perf[2]!)).toBeNull()
    expect(parsePerfdata('')).toEqual([])
  })
})

describe('commands', () => {
  const host = { backend: 'a', host: 'web1' }
  const service = { ...host, service: 'http' }

  it('are built for a host or a service', () => {
    expect(acknowledge(service, { comment: 'on it', sticky: true, notify: true, persistent: false })).toEqual({
      backend: 'a',
      command: 'ACKNOWLEDGE_SVC_PROBLEM',
      args: ['web1', 'http', 2, 1, 0, '-', 'on it'],
    })
    expect(recheck(host, 100)).toEqual({ backend: 'a', command: 'SCHEDULE_FORCED_HOST_CHECK', args: ['web1', 100] })
    const both = downtime(host, { comment: 'work', start: 10, end: 20, fixed: true, duration: 0, withServices: true })
    expect(both.map((c) => c.command)).toEqual(['SCHEDULE_HOST_DOWNTIME', 'SCHEDULE_HOST_SVC_DOWNTIME'])
    expect(both[0]?.args).toEqual(['web1', 10, 20, 1, 0, 0, '-', 'work'])
    expect(downtime(service, { comment: 'w', start: 10, end: 20, fixed: false, duration: 300 })[0]?.args).toEqual(['web1', 'http', 10, 20, 0, 0, 300, '-', 'w'])
  })
})

describe('availability', () => {
  const row = { backend: 'a', host: 'web1', service: 'http', seconds: [900, 60, 40, 0] as [number, number, number, number], unmonitored: 500 }

  it('is a share of the monitored time', () => {
    expect(percent(row, 0)).toBe(90)
    expect(percent(row, 2)).toBe(4)
    expect(percent({ ...row, seconds: [0, 0, 0, 0] }, 0)).toBeNull()
    expect(showPercent(99.9999)).toBe('99.999%')
    expect(showPercent(100)).toBe('100.000%')
    expect(showPercent(null)).toBe('n/a')
  })

  it('asks the state history, hosts apart from services', () => {
    const hosts = availabilityRequest('host', { from: 100.7, to: 200 }, { search: 'web.1\nx' })
    expect(hosts.headers.slice(0, 4)).toEqual(['Filter: time >= 100', 'Filter: time < 200', 'Filter: service_description = ', 'Filter: host_name ~~ web\\.1 x'])
    expect(hosts.headers.filter((h) => h.startsWith('Stats:'))).toHaveLength(5)
    expect(availabilityRequest('service', { from: 1, to: 2 }, { host: 'web1' }).headers).toContain('Filter: host_name = web1')
  })

  it('goes into a CSV file that a spreadsheet reads as text', () => {
    const csv = toCsv('service', { from: 100, to: 1100 }, [{ ...row, service: '=cmd,"x"' }])
    const [head, line] = csv.split('\r\n')
    expect(head).toBe('backend,host,service,from,to,ok_seconds,ok_percent,warning_seconds,warning_percent,critical_seconds,critical_percent,unknown_seconds,unknown_percent,unmonitored_seconds')
    expect(line).toBe('a,web1,"\'=cmd,""x""",100,1100,900,90.000,60,6.000,40,4.000,0,0.000,500')
    expect(toCsv('host', { from: 1, to: 2 }, []).trim().split(',')).toContain('unreachable_percent')
  })
})

describe('updates', () => {
  it('reloads for a newer build only when nothing would be lost', () => {
    expect(decide('b2', 'b1', true)).toBe('reload')
    expect(decide('b2', 'b1', false)).toBe('tell')
    expect(decide('b1', 'b1', true)).toBe('none')
    expect(decide(null, 'b1', true)).toBe('none')
  })
  it('reads the build from version.json, and nothing from anything else', async () => {
    const answer = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch
    expect(await latestBuild(answer('{"build":"abc"}'))).toBe('abc')
    expect(await latestBuild(answer('<!doctype html>'))).toBeNull()
    expect(await latestBuild(answer('{"build":1}'))).toBeNull()
    expect(await latestBuild(answer('{}', 404))).toBeNull()
    expect(await latestBuild((async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBeNull()
  })
})
