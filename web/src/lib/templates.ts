// Ready-made dashboards: one click makes a whole dashboard, which can be
// changed after. Each is laid out on the 12-column grid, top to bottom.
import type { CheckNumber, DashboardDraft, PanelSettings, Subject, Widget } from '@nuthatch/api'
import { place } from './layout'
import { subjectName } from './subjects'

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

/** One subject at the top, and panels that follow it: its status, uptime,
 * problems, what recovered, and a graph of each of `numbers`. Another
 * subject added at the top is shown by the same panels. */
export function forSubject(subject: Subject, numbers: CheckNumber[]): DashboardDraft {
  const follows = true as const
  return {
    title: subjectName(subject),
    shared: false,
    range: '24h',
    subjects: [subject],
    widgets: laid([
      [{ type: 'status', follows }, 9, 4],
      [{ type: 'availability', follows }, 3, 4],
      [{ type: 'problems', of: 'services', show: 'problems', follows }, 6, 5],
      [{ type: 'problems', of: 'services', show: 'recovered', follows }, 6, 5],
      ...numbers.slice(0, 8).map((n): [PanelSettings, number, number] => [{ type: 'metric', series: [], numbers: [n], follows }, 6, 3]),
    ]),
  }
}

export function blank(title: string): DashboardDraft {
  return { title, shared: false, range: '24h', widgets: [] }
}
