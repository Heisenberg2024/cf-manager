import { defineStore } from 'pinia';
import { ref } from 'vue';
import apiClient from '../api/client';
import { createRequestScope } from '../utils/requestScope';

export const useQuotaStore = defineStore('quota', () => {
  const quota = ref<any[]>([]);
  const loading = ref(false);
  const syncing = ref(false);
  const requests = createRequestScope();

  async function fetchQuota(refresh = false) {
    const request = requests.begin('quota');
    if (refresh) {
      syncing.value = true;
    } else {
      loading.value = true;
    }
    try {
      const { data } = await apiClient.get('/quota', {
        params: refresh ? { sync: 'true' } : undefined,
      });
      if (request.current()) quota.value = data;
    } catch {
      if (request.current()) quota.value = [];
    } finally {
      if (request.current()) { loading.value = false; syncing.value = false; }
    }
  }

  return { quota, loading, syncing, fetchQuota };
});
