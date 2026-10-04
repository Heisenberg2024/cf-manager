<template>
  <n-popover trigger="click" :show="showPopover" @update:show="showPopover = $event" placement="bottom" style="display: block; width: 100%;">
    <template #trigger>
      <div class="compact-card" :class="{ 'compact-card--no-resources': !hasResources }" @click="showPopover = true">
        <span class="compact-card__name" :title="accountName">{{ accountName }}</span>
        <div class="compact-card__dots">
          <n-tooltip v-for="item in orderedResources" :key="item.resource" trigger="hover">
            <template #trigger>
              <span class="compact-card__dot" :style="{ backgroundColor: dotColor(item) }" />
            </template>
            {{ resourceLabel(item.resource) }}: {{ calcPercentage(item) }}%<span v-if="item.exhausted">（{{ t('compactCard.exhausted') }}）</span>
          </n-tooltip>
          <span v-for="i in emptyDots" :key="'empty-' + i" class="compact-card__dot" style="background-color: var(--app-text-disabled)" />
        </div>
      </div>
    </template>

    <div class="compact-card__popover">
      <div class="compact-card__popover-title">{{ accountName }}</div>
      <div v-for="item in orderedResources" :key="item.resource" class="compact-card__popover-row">
        <div class="compact-card__popover-label">
          <span>{{ resourceLabel(item.resource) }}</span>
          <n-tag v-if="item.exhausted" size="small" type="error" :bordered="false" style="margin-left: 6px;">{{ t('compactCard.exhausted') }}</n-tag>
          <span class="compact-card__popover-value">{{ formatValue(item) }}</span>
        </div>
        <n-progress
          type="line"
          :percentage="calcPercentage(item)"
          :height="14"
          :show-indicator="false"
          :status="item.exhausted ? 'error' : progressStatus(item)"
        />
      </div>
      <div v-if="!hasResources" style="color: var(--app-text-tertiary); font-size: 13px;">{{ t('compactCard.noData') }}</div>
    </div>
  </n-popover>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

interface Resource {
  resource: string;
  count: number;
  limit: number;
  exhausted?: boolean;
}

const props = defineProps<{
  accountName: string;
  resources: Resource[];
}>();

const showPopover = ref(false);

const resourceOrder = ['workers_requests', 'ai_neurons', 'browser_render_seconds'];

function resourceLabel(resource: string) {
  const map: Record<string, string> = {
    workers_requests: t('compactCard.workersRequests'),
    ai_neurons: t('compactCard.aiNeurons'),
    browser_render_seconds: t('compactCard.browserRender'),
  };
  return map[resource] || resource;
}

function calcPercentage(r: Resource) {
  if (!r.limit) return 0;
  return Math.min(100, Math.round(((r.count || 0) / r.limit) * 100));
}

function formatValue(r: Resource) {
  if (r.resource === 'browser_render_seconds') {
    const m = Math.floor(r.count / 60);
    const s = Math.round(r.count % 60);
    const lm = Math.floor(r.limit / 60);
    const ls = Math.round(r.limit % 60);
    return `${m > 0 ? t('compactCard.minFmt', { m }) : ''}${t('compactCard.secFmt', { s })} / ${t('compactCard.minFmt', { m: lm })}${ls > 0 ? t('compactCard.secFmt', { s: ls }) : ''}`;
  }
  return `${(r.count || 0).toLocaleString()} / ${(r.limit || 0).toLocaleString()}`;
}

function dotColor(r: Resource) {
  if (r.exhausted) return 'var(--theme-error)';
  const pct = calcPercentage(r);
  if (pct > 100) return 'var(--theme-error)';
  if (pct > 90) return 'var(--theme-error)';
  if (pct > 70) return 'var(--theme-warning)';
  return 'var(--theme-success)';
}

function progressStatus(r: Resource): 'error' | 'warning' | 'success' {
  const pct = calcPercentage(r);
  if (pct > 90) return 'error';
  if (pct > 70) return 'warning';
  return 'success';
}

const orderedResources = computed(() => {
  const map = new Map(props.resources.map(r => [r.resource, r]));
  return resourceOrder.filter(key => map.has(key)).map(key => map.get(key)!);
});

const emptyDots = computed(() => Math.max(0, 3 - orderedResources.value.length));

const hasResources = computed(() => props.resources && props.resources.length > 0);
</script>

<style scoped>
.compact-card {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--glass-border-subtle);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s ease;
  background-color: var(--app-bg-card);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-sizing: border-box;
}

.compact-card:hover {
  background-color: var(--app-bg-hover);
  border-color: var(--theme-primary);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.compact-card--no-resources {
  opacity: 0.6;
  background-color: var(--app-bg-secondary);
}

.compact-card--no-resources:hover {
  background-color: var(--app-bg-tertiary);
}

.compact-card__name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}

.compact-card__dots {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
}

.compact-card__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.compact-card__popover {
  min-width: 280px;
  padding: 4px 0;
}

.compact-card__popover-title {
  font-weight: bold;
  margin-bottom: 12px;
  font-size: 14px;
}

.compact-card__popover-row {
  margin-bottom: 12px;
}

.compact-card__popover-row:last-child {
  margin-bottom: 0;
}

.compact-card__popover-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  font-size: 13px;
}

.compact-card__popover-value {
  /* 用量数值属于关键信息，用可读的次级文字色（此前是 disabled 色，浅色下几乎看不见） */
  color: var(--app-text-secondary);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 768px) {
  .compact-card__name {
    min-width: 0;
  }
  .compact-card__dot {
    width: 6px;
    height: 6px;
  }
}
</style>
