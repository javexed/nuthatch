// Ready-made dashboards: one click makes a whole dashboard, which can be
// changed after. Each is laid out on the 12-column grid, top to bottom.
import type { DashboardDraft, PanelSettings, Series, Widget } from '@nuthatch/api'
import { place } from './layout'

/** Panels in order, each where the first free place of its size is. */
function laid(panels: [PanelSettings, number, number][]): Widget[] {
  const out: Widget[] = []
  for (const [panel, w, h] of panels) out.push({ ...panel, layout: place(out.map((x) => x.layout), w, h) } as Widget)
  return out
}

/** Everything at a glance: all hosts, the problems, the alerts, and each host group. */
export function overview(groups: string[]): DashboardDraft {
  return {
    title: 'Overview',
    shared: false,
    range: '24h',
    widgets: laid([
      [{ type: 'status' }, 12, 3],
      [{ type: 'problems', of: 'services', show: 'problems' }, 6, 5],
      [{ type: 'log', lines: 'alerts' }, 6, 5],
      ...groups.slice(0, 12).map((hostgroup): [PanelSettings, number, number] => [{ type: 'status', hostgroup }, 4, 3]),
    ]),
  }
}

/** One host group: its hosts, problems, availability, recoveries, and a number per host. */
export function forGroup(group: string, numbers: Series[]): DashboardDraft {
  return {
    title: group,
    shared: false,
    range: '24h',
    widgets: laid([
      [{ type: 'status', hostgroup: group }, 9, 4],
      [{ type: 'availability', hostgroup: group }, 3, 4],
      [{ type: 'problems', of: 'services', show: 'problems', hostgroup: group }, 6, 5],
      [{ type: 'problems', of: 'services', show: 'recovered', hostgroup: group }, 6, 5],
      ...numbers.slice(0, 12).map((s): [PanelSettings, number, number] => [{ type: 'metric', series: [s] }, 3, 2]),
    ]),
  }
}

/** One host, chosen at the top: any host can be looked at with it. `metrics`
 * are of the host it was made from; they follow the chosen host. */
export function forHost(metrics: Series[], hostgroup?: string): DashboardDraft {
  const chosen = { backend: '$host', host: '$host' }
  return {
    title: 'One host',
    shared: false,
    range: '24h',
    choose_host: hostgroup ? { hostgroup } : {},
    widgets: laid([
      [{ type: 'status', of: chosen }, 9, 4],
      [{ type: 'availability', of: chosen }, 3, 4],
      ...metrics.slice(0, 8).map((s): [PanelSettings, number, number] => [{ type: 'metric', series: [{ ...s, ...chosen }] }, 6, 3]),
    ]),
  }
}

export function blank(title: string): DashboardDraft {
  return { title, shared: false, range: '24h', widgets: [] }
}
