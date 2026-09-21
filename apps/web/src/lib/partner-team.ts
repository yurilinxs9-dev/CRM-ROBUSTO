import { isAxiosError } from 'axios';
export type TeamKind = 'meeting' | 'registration' | 'training';
export const teamLabels: Record<TeamKind, string> = { meeting: 'Reunião realizada', registration: 'Cadastro efetivado', training: 'Treinamento realizado' };
export interface TeamMember { id: string; name: string; active: boolean; role: string }
export interface TeamPerformanceRow extends TeamMember { meetings: number; registrations: number; trainings: number; target: number | null; remaining: number | null; percentage: number | null; goal_version: number }
export interface TeamActivity { id: string; kind: TeamKind; partner_id: string | null; lead_id: string | null; company_name: string; consultant_id: string; consultant_name: string; occurred_on: string; occurred_time: string; note: string; cancelled: boolean; version: number }
export interface TeamDashboard { month: string; today: string; members: TeamMember[]; performance: TeamPerformanceRow[]; summary: { meetings: number; registrations: number; trainings: number; target: number | null; goals_configured: number }; history: { rows: TeamActivity[]; total: number; page: number; pages: number } }
export interface TeamSubject { id: string; type: 'lead' | 'partner'; name: string; contact: string | null; company: string; phone: string | null }
export const teamError = (error: unknown) => { const message = isAxiosError(error) ? error.response?.data?.message : error instanceof Error ? error.message : null; return typeof message === 'string' ? message : 'Não foi possível salvar. Confira os dados e tente novamente.'; };
export const teamDate = (date: string) => date.split('-').reverse().join('/');
