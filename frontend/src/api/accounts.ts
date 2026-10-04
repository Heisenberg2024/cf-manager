import apiClient from './client';

export interface AccountListParams {
  page?: number;
  pageSize?: number;
  filter?: 'all' | 'active' | 'unverified';
  search?: string;
}

export interface AccountExportParams {
  /** 仅导出指定账户（优先级高于 filter） */
  ids?: number[];
  filter?: 'all' | 'active' | 'unverified';
  search?: string;
  /** 是否包含明文凭证（apiKey/apiToken），默认 false */
  includeCredentials?: boolean;
}

export const accountsApi = {
  getAll: (params: AccountListParams = {}) =>
    apiClient.get('/accounts', { params }),
  create: (data: any) => apiClient.post('/accounts', data),
  update: (id: number, data: any) => apiClient.put(`/accounts/${id}`, data),
  delete: (id: number) => apiClient.delete(`/accounts/${id}`),
  test: (id: number) => apiClient.post(`/accounts/${id}/test`),
  testBatch: (data: { ids?: number[]; onlyUnverified?: boolean }) =>
    apiClient.post('/accounts/test-batch', data, { timeout: 600000 }),
  updateFeatures: (id: number, enabled_features: string) =>
    apiClient.patch(`/accounts/${id}/features`, { enabled_features }),
  clearExhausted: (id: number) =>
    apiClient.post(`/accounts/${id}/clear-exhausted`),
  importCsv: (file: File, skipVerify = false) => {
    const formData = new FormData();
    formData.append('file', file);
    if (skipVerify) formData.append('skipVerify', '1');
    return apiClient.post('/accounts/import-csv', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 600000,
    });
  },
  exportCsv: (params: AccountExportParams = {}) =>
    apiClient.get('/accounts/export-csv', {
      params: {
        ...(params.ids && params.ids.length > 0 ? { ids: params.ids.join(',') } : {}),
        ...(params.filter ? { filter: params.filter } : {}),
        ...(params.search ? { search: params.search } : {}),
        includeCredentials: params.includeCredentials ? '1' : '0',
      },
      responseType: 'blob',
      timeout: 300000,
      _silent: true,
    }),
  // 批量操作
  batchFeatures: (ids: number[], enabled_features: string) =>
    apiClient.post('/accounts/batch/features', { ids, enabled_features }),
  batchDelete: (ids: number[]) =>
    apiClient.post('/accounts/batch/delete', { ids }),
  batchProxy: (ids: number[], data: { proxy_url?: string; proxy_enabled?: number }) =>
    apiClient.post('/accounts/batch/proxy', { ids, ...data }),
};
