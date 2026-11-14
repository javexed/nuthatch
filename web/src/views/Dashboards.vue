<script setup lang="ts">
// The dashboards there are: one's own, and those shared with everyone.
import { ApiError } from '@nuthatch/api'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLoader } from '../stores/live'
import { api, useSession } from '../stores/session'

const session = useSession()
const router = useRouter()
const { data, error, loading } = useLoader(() => api.dashboards(), [], { live: false })
const title = ref('')
const problem = ref('')

async function make() {
  try {
    const made = await api.newDashboard({ title: title.value.trim(), shared: false, widgets: [{ type: 'totals', of: 'hosts' }, { type: 'totals', of: 'services' }] })
    await router.push({ name: 'dashboard', params: { id: made.id }, query: { edit: '1' } })
  } catch (err) {
    problem.value = err instanceof ApiError ? err.message : 'Server unreachable'
  }
}
</script>

<template>
  <h1>Dashboards</h1>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <ul v-if="data && data.length > 0" class="managed">
    <li v-for="dashboard in data" :key="dashboard.id" class="card">
      <div>
        <RouterLink :to="{ name: 'dashboard', params: { id: dashboard.id } }"><strong>{{ dashboard.title }}</strong></RouterLink>
        <span class="by">
          {{ dashboard.widgets.length }} {{ dashboard.widgets.length === 1 ? 'box' : 'boxes' }}
          <template v-if="dashboard.owner !== session.session?.user"> · by {{ dashboard.owner }}</template>
          <template v-else-if="dashboard.shared"> · shared with everyone</template>
        </span>
      </div>
    </li>
  </ul>
  <p v-else-if="!loading && !error" class="none">None</p>
  <form class="new-dashboard" @submit.prevent="make">
    <label>A new dashboard <input v-model="title" name="title" required maxlength="200" placeholder="its title" /></label>
    <button type="submit">Make it</button>
  </form>
  <p v-if="problem" class="error" role="alert">{{ problem }}</p>
</template>
