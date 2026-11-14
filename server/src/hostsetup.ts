// What happens when a host's agent says what its machine is (its
// inventory): it is kept, the base checks (disks, memory, load or
// processor) are added to the host's config once, and the rest is offered
// as proposals to take up or set aside.
//
// Checks are added only to hosts nuthatch keeps the config of; for others
// the inventory is shown and nothing is written.

import type { HostInventory, ManagedHost, ManagedService } from '@nuthatch/api'
import type { ConfigAdmin } from './configadmin.ts'
import { type Planned, open, plan, readInventory } from './proposals.ts'
import { Refused } from './policy.ts'
import type { Store } from './store.ts'

export class HostSetup {
  private readonly store: Store
  private readonly admins: Map<string, ConfigAdmin>

  constructor(store: Store, admins: Map<string, ConfigAdmin>) {
    this.store = store
    this.admins = admins
  }

  private async managed(backend: string, host: string): Promise<{ admin: ConfigAdmin; host: ManagedHost; template: string; revision: string } | undefined> {
    const admin = this.admins.get(backend)
    if (!admin) return undefined
    const state = await admin.state()
    const kept = state.hosts.find((h) => h.name === host)
    const template = state.templates.service[0]
    if (!kept || template === undefined || state.extras !== true) return undefined
    return { admin, host: kept, template, revision: state.revision }
  }

  /** Adds checks to a host nuthatch keeps; the answer is the keys added. */
  private async add(backend: string, host: string, checks: Planned[]): Promise<string[]> {
    const there = await this.managed(backend, host)
    if (!there) return []
    const fresh = open(checks, there.host.services, [])
    if (fresh.length === 0) return []
    const services: ManagedService[] = fresh.map((p) => ({ description: p.description, use: there.template, check_command: p.check_command, servicegroups: [], contacts: [], contact_groups: [] }))
    await there.admin.change(there.revision, { kind: 'put', host: { ...there.host, services: [...there.host.services, ...services] }, previous: host }, false)
    return fresh.map((p) => p.key)
  }

  /** An inventory that came from a host's agent. The first one adds the
   * base checks. */
  async take(backend: string, host: string, text: string, received: number): Promise<void> {
    const inventory = readInventory(text)
    if (!inventory) return
    const known = this.store.inventory(backend, host)
    if (known && known.received >= received) return
    this.store.keepInventory(backend, host, JSON.stringify(inventory), received)
    if (known && known.base.length > 0) return
    const base = plan(inventory).filter((p) => p.base)
    const added = await this.add(backend, host, base)
    if (added.length > 0) {
      this.store.setInventoryBase(backend, host, added)
      this.store.audit('nuthatch', backend, 'config', `base checks of ${host}: ${added.join(', ')}`)
    }
  }

  async view(backend: string, host: string): Promise<HostInventory | null> {
    const row = this.store.inventory(backend, host)
    const inventory = row && readInventory(row.body)
    if (!row || !inventory) return null
    const there = await this.managed(backend, host)
    const proposals = there ? open(plan(inventory), there.host.services, row.dismissed).map(({ key, description, why, checked }) => ({ key, description, why, checked })) : []
    return { inventory, received: row.received, managed: there !== undefined, base: row.base, proposals }
  }

  /** How many proposals wait, for a list of agents. */
  async waiting(backend: string, host: string): Promise<number> {
    return (await this.view(backend, host).catch(() => null))?.proposals.length ?? 0
  }

  /** Takes up some proposals and sets others aside. Only keys of what is
   * proposed now count: nothing sent becomes a command. */
  async decide(backend: string, host: string, add: unknown, dismiss: unknown): Promise<string[]> {
    const keys = (v: unknown) => (Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string').slice(0, 200) : [])
    const row = this.store.inventory(backend, host)
    const inventory = row && readInventory(row.body)
    if (!row || !inventory) throw new Refused(`no inventory of ${host} yet`)
    const wanted = keys(add)
    const planned = plan(inventory)
    const chosen = planned.filter((p) => wanted.includes(p.key))
    if (chosen.length > 0 && !(await this.managed(backend, host))) throw new Refused(`nuthatch does not keep the config of ${host}`)
    const added = await this.add(backend, host, chosen)
    const aside = keys(dismiss).filter((k) => planned.some((p) => p.key === k))
    if (aside.length > 0) this.store.dismissProposals(backend, host, aside)
    return added
  }

  forget(backend: string, host: string): void {
    this.store.forgetInventory(backend, host)
  }
}
