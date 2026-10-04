<template>
  <div class="ai-stats-root">
    <!-- 汇总信息（固定在顶部，不随账户卡片滚动） -->
    <div class="ai-stats-header">
      <div class="ai-stats-title">{{ t('aiStats.title', 'AI 使用量统计') }}</div>
      <n-button secondary type="primary" size="small" :loading="loading" @click="fetchUsage">{{ t('common.refresh') }}</n-button>
    </div>
    <n-spin :show="loading">
    <div class="ai-stats-summary">
      <div class="stats-summary-card">
        <span class="stats-summary-label">{{ t('aiStats.totalAccounts') }}</span>
        <span class="stats-summary-value">{{ usageData.length }}</span>
      </div>
      <div class="stats-summary-card">
        <span class="stats-summary-label">{{ t('aiStats.totalNeurons') }}</span>
        <span class="stats-summary-value">{{ totalNeurons.toLocaleString() }}</span>
      </div>
      <div class="stats-summary-card">
        <span class="stats-summary-label">{{ t('aiStats.totalRequests') }}</span>
        <span class="stats-summary-value">{{ totalRequests.toLocaleString() }}</span>
      </div>
      <div class="stats-summary-card">
        <span class="stats-summary-label">{{ t('aiStats.activeModels') }}</span>
        <span class="stats-summary-value">{{ activeModelCount }}</span>
      </div>
    </div>

    <!-- 账户用量卡片 -->
    <div class="ai-stats-cards">
      <div v-if="usageData.length === 0" class="ai-stats-empty">
        {{ t('common.noData') }}
      </div>
      <n-grid v-else :x-gap="12" :y-gap="12" cols="1 s:2 m:3 l:4" responsive="screen">
        <n-gi v-for="u in usageData" :key="u.accountId">
          <div class="ai-stats-card">
            <div class="ai-stats-card-header">
              <span class="ai-stats-card-name" :title="u.accountName">{{ u.accountName }}</span>
              <span class="ai-stats-card-badge" :class="badgeClass(u.totalNeurons)">
                {{ formatPercent(u.totalNeurons) }}
              </span>
            </div>
            <n-progress
              class="ai-stats-card-progress"
              type="line"
              :percentage="usagePercent(u.totalNeurons)"
              :color="progressColor(u.totalNeurons)"
              :rail-color="'var(--app-border-input)'"
              :height="8"
              :show-indicator="false"
            />
            <div class="ai-stats-card-info">
              <span class="ai-stats-card-info-used">{{ u.totalNeurons.toLocaleString() }}</span>
              <span class="ai-stats-card-info-total">/ 10,000 {{ t('aiStats.neurons') }}</span>
            </div>
            <div v-if="u.models.length > 0" class="ai-stats-card-models">
              <div class="ai-stats-card-models-title">
                {{ t('ai.modelDetail', { count: u.models.length }) }}
              </div>
              <div class="ai-stats-model-list">
                <div
                  v-for="m in u.models"
                  :key="m.modelId"
                  class="ai-stats-model-row"
                >
                  <span class="ai-stats-model-name" :title="m.modelId">{{ m.modelId.replace(/^@cf\//, '') }}</span>
                  <span class="ai-stats-model-meta">
                    <span class="ai-stats-model-neurons">{{ m.neurons.toLocaleString() }}</span>
                    <span class="ai-stats-model-requests">{{ m.requests.toLocaleString() }} {{ t('ai.requests') }}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </n-gi>
      </n-grid>
    </div>
    </n-spin>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { createRequestScope } from '../utils/requestScope';
import { useI18n } from 'vue-i18n';
import apiClient from '../api/client';

interface AiUsageItem {
  accountId: string;
  accountName: string;
  totalNeurons: number;
  models: Array<{ modelId: string; neurons: number; requests: number }>;
}

const { t } = useI18n();
const requests = createRequestScope();
const loading = ref(false);
const usageData = ref<AiUsageItem[]>([]);

const totalNeurons = computed(() => usageData.value.reduce((sum, u) => sum + (u.totalNeurons || 0), 0));
const totalRequests = computed(() => usageData.value.reduce((sum, u) => sum + u.models.reduce((s, m) => s + (m.requests || 0), 0), 0));
const activeModelCount = computed(() => {
  const set = new Set<string>();
  usageData.value.forEach(u => u.models.forEach(m => set.add(m.modelId)));
  return set.size;
});

/** 免费额度为 10,000 神经元/天，进度按百分比换算 */
function usagePercent(neurons: number) {
  return Math.min(Math.max((neurons || 0) / 100, 0), 100);
}

function formatPercent(neurons: number) {
  const percent = usagePercent(neurons);
  if (percent <= 0) return '0%';
  if (percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

function progressColor(neurons: number) {
  return neurons > 8000 ? 'var(--theme-error)' : 'var(--theme-primary)';
}

function badgeClass(neurons: number) {
  if (neurons > 9500) return 'badge-danger';
  if (neurons > 8000) return 'badge-warning';
  if (neurons <= 0) return 'badge-idle';
  return '';
}

async function fetchUsage() {
  loading.value = true;
  const request = requests.begin('fetchUsage');
  try {
    const { data: result } = await apiClient.get('/ai/usage');
    if (!request.current()) return;
    const data = (result as any)?.data || result;
    usageData.value = (data || []).map((d: any) => ({
      ...d,
      totalNeurons: d.totalNeurons || 0,
    }));
  } catch {
    if (!request.current()) return;
    usageData.value = [];
  } finally {
    if (request.current()) loading.value = false;
  }
}

onMounted(() => {
  fetchUsage();
});
</script>

<style scoped>
.ai-stats-root {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  overflow: hidden;
  padding: 16px 20px;
}

.ai-stats-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  flex-shrink: 0;
}

.ai-stats-title {
  font-size: 16px;
  font-weight: 600;
}

/* n-spin 的包裹层要参与 flex 链，否则下面的高度传不到卡片滚动区 */
.ai-stats-root :deep(.n-spin-container),
.ai-stats-root :deep(.n-spin-content) {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.ai-stats-summary {
  display: flex;
  gap: 16px;
  margin-bottom: 24px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

/* 统一的卡片外观：可见的描边 + 柔和投影，避免白底卡片在浅色页面里"糊"成一片 */
.stats-summary-card,
.ai-stats-card {
  border: 1px solid var(--app-border-input);
  border-radius: 10px;
  background: var(--glass-surface-solid);
  box-shadow: var(--glass-shadow);
}

.stats-summary-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 20px;
  min-width: 140px;
}

.stats-summary-label {
  font-size: 12px;
  color: var(--app-text-muted);
}

.stats-summary-value {
  font-size: 24px;
  font-weight: 600;
  color: var(--app-text-primary);
}

/* 账户用量卡片：唯一的滚动区 */
.ai-stats-cards {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  max-width: 1200px;
  padding-right: 2px;
}

.ai-stats-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--app-text-muted);
  font-size: 15px;
}

.ai-stats-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  padding: 14px 16px;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.ai-stats-card:hover {
  border-color: var(--theme-primary);
  box-shadow: var(--glass-shadow-hover);
}

.ai-stats-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.ai-stats-card-name {
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.ai-stats-card-badge {
  font-size: 11px;
  line-height: 16px;
  padding: 0 8px;
  border-radius: 9px;
  background: var(--n-color-tag);
  color: var(--app-text-secondary);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.badge-idle {
  background: var(--n-color-tag);
  color: var(--app-text-muted);
}

.badge-warning {
  background: rgba(240, 160, 32, 0.15);
  color: #e0a020;
}

.badge-danger {
  background: rgba(224, 48, 80, 0.15);
  color: var(--theme-error);
}

.ai-stats-card-progress {
  margin-bottom: 8px;
}

.ai-stats-card-progress :deep(.n-progress-graph-line-rail) {
  border-radius: 4px;
  overflow: hidden;
}

.ai-stats-card-info {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 12px;
  color: var(--app-text-muted);
}

.ai-stats-card-info-used {
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text-primary);
  font-variant-numeric: tabular-nums;
}

.ai-stats-card-models {
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--app-border-input);
}

.ai-stats-card-models-title {
  font-size: 11px;
  color: var(--app-text-muted);
  margin-bottom: 4px;
}

.ai-stats-model-list {
  max-height: 132px;
  overflow-y: auto;
}

.ai-stats-model-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
}

.ai-stats-model-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-text-secondary);
}

.ai-stats-model-meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-shrink: 0;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.ai-stats-model-neurons {
  font-weight: 500;
  color: var(--app-text-primary);
}

.ai-stats-model-requests {
  color: var(--app-text-muted);
}

@media (max-width: 768px) {
  .ai-stats-summary {
    gap: 8px;
  }
  .stats-summary-card {
    min-width: 100px;
    padding: 10px 14px;
  }
  .stats-summary-value {
    font-size: 20px;
  }
}
</style>
