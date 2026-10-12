<template>
  <n-virtual-list v-if="zones.length > 100" :items="zones" :item-size="68" item-resizable key-field="id" style="height: min(480px, 50vh)">
    <template #default="{ item }"><DnsZoneRow :zone="item" v-bind="rowProps" @select="$emit('select', item)" @toggle="checked => $emit('toggle', item, checked)" /></template>
  </n-virtual-list>
  <n-list v-else hoverable clickable>
    <DnsZoneRow v-for="zone in zones" :key="`${zone.cfAccountId}:${zone.id}`" :zone="zone" v-bind="rowProps" @select="$emit('select', zone)" @toggle="checked => $emit('toggle', zone, checked)" />
  </n-list>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import DnsZoneRow from './DnsZoneRow.vue';
const props = defineProps<{ zones: any[]; selected: Set<string>; currentKey: string; isDemo: (zone: any) => boolean; statusLabel: (status?: string) => string; statusColor: (status?: string) => string; planName: (zone: any) => string }>();
defineEmits<{ select: [zone: any]; toggle: [zone: any, checked: boolean] }>();
const rowProps = computed(() => ({ selected: props.selected, currentKey: props.currentKey, isDemo: props.isDemo, statusLabel: props.statusLabel, statusColor: props.statusColor, planName: props.planName }));
</script>
