<template>
  <n-list-item @click="$emit('select')" :style="{ background: currentKey === zoneKey ? 'var(--n-color-hover)' : '', minHeight: '68px', boxSizing: 'border-box' }">
    <div style="display: flex; align-items: flex-start; gap: 8px; width: 100%">
      <n-checkbox v-if="!isDemo(zone)" :checked="selected.has(zoneKey)" @update:checked="(checked: boolean) => $emit('toggle', checked)" @click.stop />
      <div style="flex: 1; min-width: 0">
        <div style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ zone.name }}</div>
        <n-space align="center" :size="4" style="margin-top: 2px">
          <span :style="{ color: statusColor(zone.status), fontSize: '11px' }">●</span>
          <n-text depth="3" style="font-size: 11px">{{ statusLabel(zone.status) }}</n-text>
          <n-tag size="small" :bordered="false">{{ planName(zone) }}</n-tag>
        </n-space>
      </div>
    </div>
  </n-list-item>
</template>
<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ zone: any; selected: Set<string>; currentKey: string; isDemo: (zone: any) => boolean; statusLabel: (status?: string) => string; statusColor: (status?: string) => string; planName: (zone: any) => string }>();
defineEmits<{ select: []; toggle: [checked: boolean] }>();
const zoneKey = computed(() => `${props.zone.cfAccountId}:${props.zone.id}`);
</script>
