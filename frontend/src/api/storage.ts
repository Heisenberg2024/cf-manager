import apiClient from './client';
import type { AxiosRequestConfig } from 'axios';

export const storageApi = {
  // KV
  getKvNamespaces: (accountId: number) => apiClient.get(`/storage/${accountId}/kv`),
  createKvNamespace: (accountId: number, title: string) => apiClient.post(`/storage/${accountId}/kv`, { title }),
  deleteKvNamespace: (accountId: number, nsId: string) => apiClient.delete(`/storage/${accountId}/kv/${nsId}`),
  getKvKeys: (accountId: number, nsId: string, params?: { prefix?: string; cursor?: string; limit?: number;refresh?:boolean },signal?:AbortSignal) =>
    apiClient.get(`/storage/${accountId}/kv/${nsId}/keys`, { params,signal,_silent:true }),
  getKvValue: (accountId: number, nsId: string, key: string) =>
    apiClient.get(`/storage/${accountId}/kv/${nsId}/values/${encodeURIComponent(key)}`),
  putKvValue: (accountId: number, nsId: string, key: string, value: string, options?: { expiration?: number; expiration_ttl?: number }) =>
    apiClient.put(`/storage/${accountId}/kv/${nsId}/values/${encodeURIComponent(key)}`, { value, ...options }),
  deleteKvKey: (accountId: number, nsId: string, key: string) =>
    apiClient.delete(`/storage/${accountId}/kv/${nsId}/values/${encodeURIComponent(key)}`),
  bulkDeleteKvKeys: (accountId: number, nsId: string, keys: string[]) =>
    apiClient.post(`/storage/${accountId}/kv/${nsId}/bulk-delete`, { keys }),

  // D1
  getD1Databases: (accountId: number,refresh=false,signal?:AbortSignal) => apiClient.get(`/storage/${accountId}/d1`,{params:{refresh},signal}),
  createD1Database: (accountId: number, name: string) => apiClient.post(`/storage/${accountId}/d1`, { name }),
  deleteD1Database: (accountId: number, dbId: string) => apiClient.delete(`/storage/${accountId}/d1/${dbId}`),
  getD1Tables: (accountId: number, dbId: string,refresh=false,signal?:AbortSignal) => apiClient.get(`/storage/${accountId}/d1/${dbId}/tables`,{params:{refresh},signal}),
  getD1TableSchema: (accountId: number, dbId: string, tableName: string,refresh=false,signal?:AbortSignal) =>
    apiClient.get(`/storage/${accountId}/d1/${dbId}/tables/${encodeURIComponent(tableName)}/schema`,{params:{refresh},signal}),
  getD1TableData:(accountId:number,dbId:string,tableName:string,cursor?:string,limit=100,signal?:AbortSignal)=>apiClient.get(`/storage/${accountId}/d1/${dbId}/tables/${encodeURIComponent(tableName)}/data`,{params:{cursor,limit},signal,_silent:true}),
  executeD1Query: (accountId: number, dbId: string, sql: string, allowWrite = false,signal?:AbortSignal) =>
    apiClient.post(`/storage/${accountId}/d1/${dbId}/query`, { sql, allowWrite },{signal}),

  // R2
  getR2Buckets: (accountId: number, config?: AxiosRequestConfig) => apiClient.get(`/storage/${accountId}/r2`, config),
  createR2Bucket: (accountId: number, name: string) => apiClient.post(`/storage/${accountId}/r2`, { name }),
  deleteR2Bucket: (accountId: number, bucket: string) => apiClient.delete(`/storage/${accountId}/r2/${bucket}`),
  getR2Objects: (accountId: number, bucket: string, params?: { prefix?: string; delimiter?: string; cursor?: string; limit?: number;refresh?:boolean },signal?:AbortSignal) =>
    apiClient.get(`/storage/${accountId}/r2/${bucket}/objects`, { params,signal,_silent:true }),
  downloadR2Object: (accountId: number, bucket: string, key: string,signal?:AbortSignal) =>
    apiClient.get(`/storage/${accountId}/r2/${bucket}/download`, { params: { key }, responseType: 'blob',signal }),
  uploadR2Object: (accountId: number, bucket: string, key: string, file: File) => {
    const formData = new FormData();
    formData.append('key', key);
    formData.append('file', file);
    return apiClient.put(`/storage/${accountId}/r2/${bucket}/upload`, formData);
  },
  deleteR2Object: (accountId: number, bucket: string, key: string) =>
    apiClient.delete(`/storage/${accountId}/r2/${bucket}/objects`, { params: { key } }),
  bulkDeleteR2Objects: (accountId: number, bucket: string, keys: string[]) =>
    apiClient.post(`/storage/${accountId}/r2/${bucket}/bulk-delete`, { keys }),
};

export const tasksApi = {
  getAll: () => apiClient.get('/tasks'),
  create: (data: { name: string; type: string; cron: string; config?: any }) => apiClient.post('/tasks', data),
  update: (id: number, data: any) => apiClient.put(`/tasks/${id}`, data),
  delete: (id: number) => apiClient.delete(`/tasks/${id}`),
  run: (id: number) => apiClient.post(`/tasks/${id}/run`),
  getHistory: (id: number, limit = 20) => apiClient.get(`/tasks/${id}/history`, { params: { limit } }),
};
