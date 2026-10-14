import apiClient from './client';
import type { ZoneContext } from './dns';
import type { TunnelConfig, TunnelSnapshot } from '../shared/tunnelConfig';

export interface WizardPayload {
  mode: 'create' | 'reuse';
  tunnelId?: string;
  hostname: string;
  port: number;
  tunnelName?: string;
  protocol?: string;
  path?: string;
  zoneId?: string;
}

const rulesPath = (domain: string, phase: string, context: ZoneContext) => phase === 'http_request_redirect'
  ? `/tunnels/accounts/${context.accountId}/rules/${phase}`
  : `/dns/domains/${encodeURIComponent(domain)}/rules/${phase}`;

export const tunnelsApi = {
  getAccounts: () => apiClient.get('/tunnels/accounts'),
  getZones: (accountId: number) => apiClient.get(`/tunnels/accounts/${accountId}/zones`, { _silent: true }),
  listTunnels: (accountId: number, refresh = false) => apiClient.get(`/tunnels/accounts/${accountId}/tunnels`, { params: { refresh }, _silent: true }),
  createTunnel: (accountId: number, name: string) => apiClient.post(`/tunnels/accounts/${accountId}/tunnels`, { name }),
  deleteTunnel: (accountId: number, tunnelId: string) => apiClient.delete(`/tunnels/accounts/${accountId}/tunnels/${tunnelId}`),
  getToken: (accountId: number, tunnelId: string) => apiClient.get(`/tunnels/accounts/${accountId}/tunnels/${tunnelId}/token`),
  getConnections: (accountId: number, tunnelId: string, refresh = false) => apiClient.get(`/tunnels/accounts/${accountId}/tunnels/${tunnelId}/connections`, { params: { refresh } }),
  getConfig: (accountId: number, tunnelId: string, signal?: AbortSignal) => apiClient.get(`/tunnels/accounts/${accountId}/tunnels/${tunnelId}/config`, { signal, _silent: true }),
  getHostnames: (accountId: number, tunnelId: string, verify = false, signal?: AbortSignal) => apiClient.get(`/tunnels/accounts/${accountId}/tunnels/${tunnelId}/hostnames`, { params: { verify }, signal }),
  updateConfig: (accountId: number, tunnelId: string, config: TunnelConfig, baseline: TunnelSnapshot) => apiClient.put(`/tunnels/accounts/${accountId}/tunnels/${tunnelId}/config`, { config, baseline }),
  runWizard: (accountId: number, payload: WizardPayload) => apiClient.post(`/tunnels/accounts/${accountId}/wizard`, payload),
  // 通用规则引擎
  listRules: (domain: string, phase: string, context: ZoneContext = {}, refresh = false) => apiClient.get(rulesPath(domain, phase, context), { params: { ...context, refresh }, _silent: true }),
  createRule: (domain: string, phase: string, rule: any, context: ZoneContext = {}) => apiClient.post(rulesPath(domain, phase, context), rule, { params: context }),
  updateRule: (domain: string, phase: string, ruleId: string, rule: any, context: ZoneContext = {}) => apiClient.put(`${rulesPath(domain, phase, context)}/${ruleId}`, rule, { params: context }),
  deleteRule: (domain: string, phase: string, ruleId: string, context: ZoneContext = {}, baseline?: unknown) => apiClient.delete(`${rulesPath(domain, phase, context)}/${ruleId}`, { params: context, data: { baseline } }),
};
