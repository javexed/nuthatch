// How many problems nobody has taken care of, as the Problems page counts
// them: hosts down or unreachable, services not OK, neither acknowledged
// nor in a downtime. For the bottom bar's badge and the overview.

import { computed } from 'vue'
import { useLoader } from './live'
import { api } from './session'

const UNHANDLED = ['Stats: acknowledged = 0', 'Stats: scheduled_downtime_depth = 0']

export function useProblemCount() {
  const hosts = useLoader(() =>
    api.stats({ table: 'hosts', headers: ['Stats: state != 0', 'Stats: has_been_checked = 1', ...UNHANDLED, `StatsAnd: ${UNHANDLED.length + 2}`] }),
  )
  const services = useLoader(() =>
    api.stats({
      table: 'services',
      headers: [
        'Stats: state != 0',
        'Stats: has_been_checked = 1',
        ...UNHANDLED,
        'Stats: host_acknowledged = 0',
        'Stats: host_scheduled_downtime_depth = 0',
        `StatsAnd: ${UNHANDLED.length + 4}`,
      ],
    }),
  )
  const first = (data: { groups: { values: number[] }[] } | null) => data?.groups[0]?.values[0] ?? 0
  const loaded = computed(() => hosts.data.value !== null && services.data.value !== null && !hosts.error.value && !services.error.value)
  return {
    loaded,
    hosts: computed(() => first(hosts.data.value)),
    services: computed(() => first(services.data.value)),
    total: computed(() => first(hosts.data.value) + first(services.data.value)),
  }
}
