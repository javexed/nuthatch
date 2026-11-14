import type { Discovery, ManagedHost } from '@nuthatch/api'
import { describe, expect, it } from 'vitest'
import { compare, portsOf, withGained } from './rediscover'

const service = (description: string, check_command?: string) => ({ description, use: 's', check_command, servicegroups: [], contacts: [], contact_groups: [] })
const host: ManagedHost = {
  name: 'nas',
  address: 'nas.example.test',
  use: 'h',
  hostgroups: [],
  contacts: [],
  contact_groups: [],
  services: [service('SSH', 'nuthatch_ssh!22'), service('Web', 'nuthatch_http!80!/'), service('Load', 'check_load!1!2'), service('Postgres', 'nuthatch_tcp!5432')],
}
const seen = (ports: number[], suggestions: [string, string][]): Discovery => ({
  input: host.address,
  name: 'nas',
  address: host.address,
  addresses: [],
  ping: { ok: true },
  found: ports.map((port) => ({ port, service: '', kind: 'open' as const })),
  suggestions: suggestions.map(([description, check_command]) => ({ description, check_command, checked: true, why: '' })),
})

describe('a host looked at again', () => {
  it('has gained what answers now and is not checked, and lost what is checked and does not answer', () => {
    const changes = compare(host, seen([22, 80, 443], [['SSH', 'nuthatch_ssh!22'], ['Web', 'nuthatch_http!80!/'], ['HTTPS', 'nuthatch_https!443!/']]))
    expect(changes.gained.map((s) => s.description)).toEqual(['HTTPS'])
    // A check that is of no port (Load) is not said to be lost.
    expect(changes.lost).toEqual([{ description: 'Postgres', port: 5432 }])
    const merged = withGained(host, changes.gained, 's')
    expect(merged.services.map((s) => s.description)).toEqual(['SSH', 'Web', 'Load', 'Postgres', 'HTTPS'])
    expect(merged.services.at(-1)?.check_command).toBe('nuthatch_https!443!/')
  })

  it('does not offer another check of a port that is checked', () => {
    const changes = compare(host, seen([22, 80, 5432], [['Port 80', 'nuthatch_tcp!80'], ['Port 5432', 'nuthatch_tcp!5432']]))
    expect(changes).toEqual({ gained: [], lost: [] })
    expect(portsOf(host).sort((a, b) => a - b)).toEqual([22, 80, 5432])
  })

  it('is the same when nothing changed', () => {
    expect(compare(host, seen([22, 80, 5432], [['SSH', 'nuthatch_ssh!22'], ['Web', 'nuthatch_http!80!/'], ['Port 5432', 'nuthatch_tcp!5432']]))).toEqual({ gained: [], lost: [] })
  })
})
