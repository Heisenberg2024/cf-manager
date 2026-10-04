import apiClient from './client';

export interface CloudflareAccount { id: string; name: string }
export interface CredentialBinding { id: number; name: string; account_id: string | null; is_active: number; is_enabled: number; access_status: string }
export interface Credential { id: number; name: string; auth_type: 'token' | 'global_key'; email: string | null; status: string; last_checked_at: string | null; accounts: CredentialBinding[] }
export interface CredentialInput { name?: string; auth_type: 'token' | 'global_key'; api_token?: string; api_key?: string; email?: string; account_id?: string; selected_account_ids?: string[] }
export interface Discovery { status: string; credentialStatus: string; accounts: CloudflareAccount[]; message?: string }
export interface CredentialSync { discovery: Discovery; new_accounts: CloudflareAccount[]; results: Array<{ id: number; name: string; account_id: string | null; status: string; message?: string }> }
export const credentialsApi = {
  list: () => apiClient.get<Credential[]>('/credentials'),
  discover: (data: CredentialInput) => apiClient.post<Discovery>('/credentials/discover', data, { timeout: 120000 }),
  create: (data: CredentialInput) => apiClient.post('/credentials', data, { timeout: 120000 }),
  update: (id: number, data: CredentialInput) => apiClient.put(`/credentials/${id}`, data, { timeout: 120000 }),
  sync: (id: number) => apiClient.post<CredentialSync>(`/credentials/${id}/sync`, {}, { timeout: 300000 }),
  bind: (id: number, data: { selected_account_ids?: string[]; account_id?: string }) => apiClient.post(`/credentials/${id}/accounts`, data, { timeout: 120000 }),
  delete: (id: number) => apiClient.delete(`/credentials/${id}`),
};
