import apiClient from './client';
import type { ZoneContext } from './dns';

export interface WizardPayload {
  mode: 'create' | 'reuse';
  tunnelId?: string;
  hostname: string;
  port: number;
  tunnelName?: string;
}

export const tunnelsApi = {
  getAccounts: () => apiClient.get('/tunnels/accounts'),
  getZones: (accountId: number) => apiClient.get(`/tunnels/accounts/${accountId}/zones`),
  listTunnels: (accountId: number) => apiClient.get(`/tunnels/accounts/${accountId}/tunnels`),
  createTunnel: (accountId: number, name: string) => apiClient.post(`/tunnels/accounts/${accountId}/tunnels`, { name }),
  deleteTunnel: (accountId: number, tunnelId: string) => apiClient.delete(`/tunnels/accounts/${accountId}/tunnels/${tunnelId}`),
  getToken: (accountId: number, tunnelId: string) => apiClient.get(`/tunnels/accounts/${accountId}/tunnels/${tunnelId}/token`),
  getConnections: (accountId: number, tunnelId: string) => apiClient.get(`/tunnels/accounts/${accountId}/tunnels/${tunnelId}/connections`),
  getConfig: (accountId: number, tunnelId: string) => apiClient.get(`/tunnels/accounts/${accountId}/tunnels/${tunnelId}/config`),
  getHostnames: (accountId: number, tunnelId: string) => apiClient.get(`/tunnels/accounts/${accountId}/tunnels/${tunnelId}/hostnames`),
  updateConfig: (accountId: number, tunnelId: string, ingress: any[]) => apiClient.put(`/tunnels/accounts/${accountId}/tunnels/${tunnelId}/config`, { ingress }),
  runWizard: (accountId: number, payload: WizardPayload) => apiClient.post(`/tunnels/accounts/${accountId}/wizard`, payload),
  // 通用规则引擎
  listRules: (domain: string, phase: string, context: ZoneContext = {}) => apiClient.get(`/dns/domains/${domain}/rules/${phase}`, { params: context }),
  createRule: (domain: string, phase: string, rule: any, context: ZoneContext = {}) => apiClient.post(`/dns/domains/${domain}/rules/${phase}`, rule, { params: context }),
  updateRule: (domain: string, phase: string, ruleId: string, rule: any, context: ZoneContext = {}) => apiClient.put(`/dns/domains/${domain}/rules/${phase}/${ruleId}`, rule, { params: context }),
  deleteRule: (domain: string, phase: string, ruleId: string, context: ZoneContext = {}) => apiClient.delete(`/dns/domains/${domain}/rules/${phase}/${ruleId}`, { params: context }),
};
