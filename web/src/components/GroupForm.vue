<script setup lang="ts">
// A host group or a service group, to add or to change. Its members may be
// any of the engine's hosts or services; the engine checks they exist.
import type { ConfigState, ManagedGroup } from '@nuthatch/api'
import { computed, reactive } from 'vue'

const props = defineProps<{
  state: ConfigState
  /** The group being changed; none for a new one. */
  group?: ManagedGroup
  /** The kind of a new group. */
  type: ManagedGroup['type']
  busy: boolean
}>()
const emit = defineEmits<{ check: [group: ManagedGroup]; save: [group: ManagedGroup]; cancel: [] }>()

const kind = computed(() => props.group?.type ?? props.type)
const form = reactive({
  name: props.group?.name ?? '',
  alias: props.group?.alias ?? '',
  members: [...(props.group?.members ?? [])],
  typed: '',
})
const hosts = computed(() => props.state.choices.hosts ?? [])

function result(): ManagedGroup {
  const typed = form.typed.split('\n').map((m) => m.trim()).filter((m) => m !== '')
  return { type: kind.value, name: form.name.trim(), alias: form.alias.trim() || undefined, members: kind.value === 'hostgroup' ? form.members : typed }
}
if (kind.value === 'servicegroup') form.typed = form.members.join('\n')
</script>

<template>
  <form class="group-form card" @submit.prevent="emit('save', result())">
    <h2>{{ group ? `Change ${group.name}` : kind === 'hostgroup' ? 'New host group' : 'New service group' }}</h2>
    <div class="fields">
      <label>Name <input v-model.trim="form.name" name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" maxlength="63" autocapitalize="none" /></label>
      <label>Alias <input v-model="form.alias" name="alias" maxlength="200" placeholder="what people see" /></label>
      <label v-if="kind === 'hostgroup'" class="wide">
        Hosts
        <select v-model="form.members" name="members" multiple size="8">
          <option v-for="name in hosts" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label v-else class="wide">
        Services (host/service, one per line)
        <textarea v-model="form.typed" name="members" rows="6" autocapitalize="none" spellcheck="false" placeholder="web1/http&#10;web2/http"></textarea>
      </label>
    </div>
    <div class="buttons">
      <button type="button" class="quiet" :disabled="busy" @click="emit('cancel')">Cancel</button>
      <button type="button" class="quiet" :disabled="busy" @click="emit('check', result())">Check only</button>
      <button type="submit" :disabled="busy">Save and apply</button>
    </div>
  </form>
</template>
