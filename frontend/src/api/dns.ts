import apiClient from './client';

export interface ZoneContext { accountId?: number; zoneId?: string }
export interface ZoneSelection extends ZoneContext { name: string }
const domainPath = (domain: string) => `/dns/domains/${encodeURIComponent(domain)}`;

export const dnsApi = {
  // 现有方法
  getDomains: (refresh = false) => apiClient.get('/dns/domains', { params: refresh ? { refresh: true } : {} }),
  getRecords: (domain: string, context: ZoneContext = {}) => apiClient.get(`${domainPath(domain)}/records`, { params: context }),
  createRecord: (domain: string, data: any, context: ZoneContext = {}) => apiClient.post(`${domainPath(domain)}/records`, data, { params: context }),
  updateRecord: (domain: string, id: string, data: any, context: ZoneContext = {}) => apiClient.put(`${domainPath(domain)}/records/${id}`, data, { params: context }),
  deleteRecord: (domain: string, id: string, context: ZoneContext = {}) => apiClient.delete(`${domainPath(domain)}/records/${id}`, { params: context }),
  getSettings: (domain: string, context: ZoneContext = {}) => apiClient.get(`${domainPath(domain)}/settings`, { params: context }),
  updateProxy: (domain: string, recordId: string, proxied: boolean, context: ZoneContext = {}) => apiClient.patch(`${domainPath(domain)}/proxy`, { record_id: recordId, proxied }, { params: context }),

  // Zone 管理
  createDomains: (data: { names: string[]; account_id: number; type: 'full' | 'partial' }) =>
    apiClient.post('/dns/domains', data),
  deleteDomains: (domains: Array<string | ZoneSelection>) =>
    apiClient.delete('/dns/domains', { data: { domains } }),
  updateSettings: (domain: string, settings: Record<string, any>, context: ZoneContext = {}) =>
    apiClient.patch(`${domainPath(domain)}/settings`, settings, { params: context }),
  purgeCache: (domain: string, data: { purge_everything?: boolean; files?: string[] }, context: ZoneContext = {}) =>
    apiClient.post(`${domainPath(domain)}/purge-cache`, data, { params: context }),
  updateStatus: (domain: string, paused: boolean, context: ZoneContext = {}) =>
    apiClient.patch(`${domainPath(domain)}/status`, { paused }, { params: context }),
};
