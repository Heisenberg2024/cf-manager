import apiClient, { API_BASE_URL } from './client';
import { readBatchStream } from '../utils/batchStream';
import type { BatchSpec, BatchPreview, BatchEvent } from '../shared/dnsBatch';
import type { ChangeZonePlanResult, CreateZoneResult, ZonePlan, ZonePlanId, ZonePlanOption } from '../shared/zonePlans';

export interface ZoneContext { accountId?: number; zoneId?: string }
export interface ZoneSelection extends ZoneContext { name: string }
export interface PlanChangeTarget { name: string; accountId: number; zoneId: string; accountLabel: string; plan?: ZonePlan }
export interface DeleteZoneResult extends ZoneSelection { success: boolean; error?: string; outcome_uncertain?: boolean }
export interface DeleteZonesResult { total: number; succeeded: number; failed: number; results: DeleteZoneResult[] }
const domainPath = (domain: string) => `/dns/domains/${encodeURIComponent(domain)}`;

export const dnsApi = {
  previewBatch: (spec: BatchSpec) => apiClient.post<BatchPreview>('/dns/batch/preview', spec, {timeout: 0, _silent: true}),
  async executeBatch(preview: BatchPreview, receive: (event: BatchEvent) => void) {
    const response = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/dns/batch/execute`, {method: 'POST', headers: {'Content-Type':'application/json', Authorization: `Bearer ${localStorage.getItem('api_token') || ''}`}, body: JSON.stringify(preview)});
    if(!response.ok) {
      const body = await response.json();
      if(response.status === 401 && body.error?.code === 'UNAUTHORIZED') { localStorage.removeItem('api_token'); window.dispatchEvent(new Event('auth-expired')); }
      throw new Error(body.error?.message || `HTTP ${response.status}`);
    }
    await readBatchStream(response, receive);
  },
  // 现有方法
  getDomains: (refresh = false) => apiClient.get('/dns/domains', { params: refresh ? { refresh: true } : {} }),
  getAccountDomains: (accountId: number, refresh = false, signal?: AbortSignal) => apiClient.get(`/dns/accounts/${accountId}/domains`, { params: { refresh }, signal, _silent: true }),
  getRecords: (domain: string, context: ZoneContext = {}, signal?: AbortSignal, query: Record<string, unknown> = {}) => apiClient.get(`${domainPath(domain)}/records`, { params: { ...context, ...query }, signal, _silent: true }),
  createRecord: (domain: string, data: any, context: ZoneContext = {}) => apiClient.post(`${domainPath(domain)}/records`, data, { params: context }),
  updateRecord: (domain: string, id: string, data: any, context: ZoneContext = {}) => apiClient.put(`${domainPath(domain)}/records/${id}`, data, { params: context }),
  deleteRecord: (domain: string, id: string, context: ZoneContext = {}) => apiClient.delete(`${domainPath(domain)}/records/${id}`, { params: context }),
  getSettings: (domain: string, context: ZoneContext = {}, signal?: AbortSignal) => apiClient.get(`${domainPath(domain)}/settings`, { params: context, signal, _silent: true }),
  updateProxy: (domain: string, recordId: string, proxied: boolean, context: ZoneContext = {}) => apiClient.patch(`${domainPath(domain)}/proxy`, { record_id: recordId, proxied }, { params: context }),

  // Zone 管理
  getPlans: (accountId: number) => apiClient.get<{ plans: ZonePlanOption[]; source: string }>(`/dns/accounts/${accountId}/plans`, { _silent: true }),
  getZonePlans: (domain: string, context: ZoneContext) => apiClient.get<{ plans: ZonePlanOption[]; plan?: ZonePlan }>(`${domainPath(domain)}/plans`, { params: context, _silent: true }),
  changePlan: (domain: string, plan: ZonePlanId, context: ZoneContext) => apiClient.patch<ChangeZonePlanResult>(`${domainPath(domain)}/plan`, { plan }, { params: context, timeout: 0, _silent: true }),
  createDomains: (data: { names: string[]; account_id: number; type: 'full' | 'partial'; plan?: ZonePlanId }) =>
    apiClient.post<{ total: number; results: CreateZoneResult[] }>('/dns/domains', data, { timeout: 0, _silent: true }),
  deleteDomains: (domains: Array<string | ZoneSelection>) =>
    apiClient.delete<DeleteZonesResult>('/dns/domains', { data: { domains }, timeout: 0, _silent: true }),
  updateSettings: (domain: string, settings: Record<string, any>, context: ZoneContext = {}) =>
    apiClient.patch(`${domainPath(domain)}/settings`, settings, { params: context }),
  purgeCache: (domain: string, data: { purge_everything?: boolean; files?: string[] }, context: ZoneContext = {}) =>
    apiClient.post(`${domainPath(domain)}/purge-cache`, data, { params: context }),
  updateStatus: (domain: string, paused: boolean, context: ZoneContext = {}) =>
    apiClient.patch(`${domainPath(domain)}/status`, { paused }, { params: context }),
};
