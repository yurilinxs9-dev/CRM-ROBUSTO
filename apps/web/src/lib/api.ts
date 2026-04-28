import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/auth.store';

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || '',
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

type RetryConfig = InternalAxiosRequestConfig & { _retry?: boolean };

let isRefreshing = false;
let refreshSubscribers: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = [];

function flushRefreshSubscribers(token: string | null, err?: unknown) {
  const subs = refreshSubscribers;
  refreshSubscribers = [];
  if (token) subs.forEach((s) => s.resolve(token));
  else subs.forEach((s) => s.reject(err));
}

function isAuthEndpoint(url: string | undefined): boolean {
  if (!url) return false;
  return /\/api\/auth\/(login|refresh|register|logout)/.test(url);
}

let redirecting = false;
function bounceToLogin() {
  if (redirecting) return;
  redirecting = true;
  try {
    useAuthStore.getState().logout();
  } catch {}
  if (typeof window !== 'undefined') {
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as RetryConfig | undefined;

    // Sem config (erro de rede puro) ou status diferente de 401 → propaga.
    if (!originalRequest || error.response?.status !== 401) {
      return Promise.reject(error);
    }

    // Endpoints de auth NUNCA passam pelo refresh-loop. Se /refresh retornou
    // 401, sessão expirou de vez — manda pro /login. Login/register 401 são
    // erros de credencial, não problema de token.
    if (isAuthEndpoint(originalRequest.url)) {
      if (originalRequest.url?.includes('/api/auth/refresh')) {
        flushRefreshSubscribers(null, error);
        bounceToLogin();
      }
      return Promise.reject(error);
    }

    // Já tentou retry uma vez → não tenta de novo (evita loops).
    if (originalRequest._retry) {
      return Promise.reject(error);
    }
    originalRequest._retry = true;

    // Refresh já em andamento — entra na fila e aguarda o token novo.
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        refreshSubscribers.push({
          resolve: (token: string) => {
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${token}`;
            }
            resolve(api(originalRequest));
          },
          reject,
        });
      });
    }

    isRefreshing = true;
    try {
      const { data } = await api.post<{ accessToken: string }>('/api/auth/refresh');
      const newToken = data.accessToken;
      useAuthStore.getState().updateToken(newToken);
      isRefreshing = false;
      flushRefreshSubscribers(newToken);
      if (originalRequest.headers) {
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
      }
      return api(originalRequest);
    } catch (refreshErr) {
      isRefreshing = false;
      flushRefreshSubscribers(null, refreshErr);
      bounceToLogin();
      return Promise.reject(refreshErr);
    }
  },
);
