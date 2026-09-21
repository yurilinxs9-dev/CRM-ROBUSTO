import { api } from './api';
import { isAxiosError } from 'axios';
export const FINANCE_TENANT = 'a44772ed-1382-4400-84fc-3fa350e23e42';
export const FINANCE_PLATFORM_OWNER = '6b854bc0-c935-45a1-b0b4-5a333703dc73';
export const isFinanceOwner = (user?: { id: string; is_platform_admin?: boolean; platform_scopes?: string[] } | null) => user?.id === FINANCE_PLATFORM_OWNER && user.is_platform_admin === true && user.platform_scopes?.includes('*') === true;
export const FINANCE_USER = '4f72be61-f5a6-4222-bbfd-074c4da31b87';
export const canAccessFinance = (tenant?: string, user?: string) => tenant === FINANCE_TENANT && user === FINANCE_USER;
export const financeError = (e: unknown) => { if (isAxiosError(e)) {
    const message = e.response?.data?.message;
    return typeof message === 'string' ? message : 'Não foi possível concluir. Tente novamente.';
} return e instanceof Error ? e.message : 'Não foi possível concluir.'; };
export const financeLocked = (e: unknown) => isAxiosError(e) && (e.response?.status === 403 || e.response?.data?.code === 'FINANCE_LOCKED');
export async function financeRequest<T>(path: string, token?: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', data?: unknown, params?: Record<string, string | number | undefined>): Promise<T> { return (await api.request<T>({ url: '/api/financeiro/' + path, method, data, params, headers: token ? { 'X-Finance-Session': token } : undefined })).data; }
export interface FinanceRule {
    id: string;
    version: number;
    total_bps: number;
    distribution: number[];
    created_at: string;
}
export interface FinanceInstallment {
    id: string;
    sale_id: string;
    description: string;
    source_type: string;
    number: number;
    rate_bps: number;
    amount: string;
    due_on: string;
    due_overridden: boolean;
    received_on: string | null;
    status: 'pending' | 'received' | 'overdue';
    version: number;
}
export interface FinanceSale {
    id: string;
    source_type: string;
    source_key: string;
    description: string;
    amount: string;
    closed_on: string;
    commission_total: string;
    needs_review: boolean;
    cancelled: boolean;
    version: number;
    installment_count: number;
    source_current: {
        amount: string;
        closed_on: string;
        version: number;
    } | null;
}
export interface FinanceMonth {
    month: string;
    expected: string;
    received: string;
    settled: string;
    pending: string;
    sales_count: number;
    installments: FinanceInstallment[];
}
export interface FinanceDashboard {
    today: string;
    month: string;
    months: number;
    rule: FinanceRule;
    monthly: FinanceMonth[];
    received_total: string;
    projection_total: string;
    pending_total: string;
    overdue: {
        count: number;
        amount: string;
    };
    review_count: number;
}
export interface FinanceHistory {
    total: number;
    page: number;
    rows: FinanceInstallment[];
}
export interface FinanceAudit {
    id: string;
    action: string;
    entity_id: string;
    before: unknown;
    after: unknown;
    created_at: string;
}
export type FinanceCall = <T>(path: string, method?: 'GET' | 'POST' | 'PATCH', data?: unknown, params?: Record<string, string | number | undefined>) => Promise<T>;
export const humanDate = (value: string) => value.split('-').reverse().join('/');
export const humanMonth = (value: string) => new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(value + '-01T12:00:00Z'));
