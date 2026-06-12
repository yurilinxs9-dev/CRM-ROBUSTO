'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface Sector {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
  _count?: { users: number };
}

/**
 * F-01 — Setores do tenant. Por padrão só ativos (para dropdowns). `all=true`
 * inclui inativos (tela de gerenciamento).
 */
export function useSectors(all = false) {
  return useQuery<Sector[]>({
    queryKey: ['sectors', all],
    queryFn: async () => {
      const res = await api.get('/api/sectors', { params: all ? { all: 'true' } : {} });
      return res.data as Sector[];
    },
  });
}
