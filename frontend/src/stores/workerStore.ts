import { defineStore } from 'pinia';
import { ref } from 'vue';
import { workersApi } from '../api/workers';
import { createRequestScope } from '../utils/requestScope';

export const useWorkerStore = defineStore('workers', () => {
  const workers = ref<any[]>([]);
  const loading = ref(false);

  // 账户摘要（用量 + 已部署数量）
  const summary = ref<any[]>([]);
  const summaryLoading = ref(false);

  // 当前按需选中的账户（点击顶部卡片）
  const selectedAccountId = ref<number | null>(null);
  const requests = createRequestScope(() => String(selectedAccountId.value));

  async function fetchSummary() {
    const request = requests.begin('summary', () => 'all');
    summaryLoading.value = true;
    try {
      const { data } = await workersApi.getSummary();
      if (!request.current()) return;
      summary.value = Array.isArray(data) ? data : [];
    } catch {
      if (request.current()) summary.value = [];
    } finally {
      if (request.current()) summaryLoading.value = false;
    }
  }

  // 按需加载指定账户的 Worker/Pages；不传 accountId 则加载全部
  async function fetchWorkers(accountId?: number | null) {
    const request = requests.begin('workers');
    workers.value = [];
    loading.value = true;
    try {
      const { data } = await workersApi.getAll(accountId ?? undefined);
      if (!request.current()) return;
      workers.value = Array.isArray(data) ? data : [];
    } catch {
      if (request.current()) workers.value = [];
    } finally {
      if (request.current()) loading.value = false;
    }
  }

  // 批量部署/环境同步需要全部账户数据
  async function fetchAllWorkers(): Promise<any[]> {
    try {
      const { data } = await workersApi.getAll();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  return {
    workers, loading,
    summary, summaryLoading, selectedAccountId,
    fetchSummary, fetchWorkers, fetchAllWorkers,
  };
});
