import axios, { type AxiosError } from 'axios';
import { message as globalMessage } from '../utils/discreteApi';
import i18n from '../i18n';

declare module 'axios' {
  interface AxiosRequestConfig {
    _silent?: boolean;
  }
}

export interface ApiError extends AxiosError {
  errorMessage: string;
}

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60000,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('api_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => {
    const body = response.data;
    if (body && typeof body === 'object' && body.success !== undefined) {
      response.data = body.data;
    }
    return response;
  },
  (error: ApiError) => {
    const body = error?.response?.data as any;
    const errObj = body?.error;
    if (errObj) {
      error.errorMessage = typeof errObj === 'string'
        ? errObj
        : (errObj.message || JSON.stringify(errObj));
    } else {
      error.errorMessage = body?.message || error?.message || i18n.global.t('common.networkError');
    }

    // Cloudflare 权限错误不代表管理 API_SECRET 失效。
    if ((error?.response?.status === 401 && errObj?.code === 'UNAUTHORIZED') || (error?.response?.status === 403 && errObj?.code === 'FORBIDDEN')) {
      localStorage.removeItem('api_token');
      window.dispatchEvent(new Event('auth-expired'));
    }

    if (!error.config?._silent) {
      globalMessage.error(error.errorMessage, { duration: 5000 });
    }

    return Promise.reject(error);
  }
);

export default apiClient;
