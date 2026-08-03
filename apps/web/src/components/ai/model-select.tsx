'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

export interface AiModel {
  id: string;
  label: string;
  provider: 'openai_compatible' | 'anthropic';
  base_url: string | null;
  model_id: string;
  key_mask: string;
  temperature: number;
  max_tokens: number;
  active: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export function useAiModels() {
  return useQuery<AiModel[]>({
    queryKey: ['ai-models'],
    queryFn: async () => (await api.get<AiModel[]>('/api/ai/models')).data,
  });
}

/**
 * Só os modelos ATIVOS — os que o usuário consegue de fato escolher no
 * `ModelSelect`, que filtra por `active`.
 *
 * Existe separado de `useAiModels` de propósito: telas de administração
 * precisam enxergar os inativos para reativá-los, mas quem só quer saber "dá
 * para usar IA aqui?" tem que contar apenas os utilizáveis. Contar inativos
 * faria o aviso "nenhum modelo configurado" sumir enquanto o seletor aparece
 * vazio, deixando criar um follow-up em modo IA sem modelo — que só falharia
 * na hora do disparo.
 */
export function useAvailableAiModels() {
  return useQuery<AiModel[]>({
    queryKey: ['ai-models', 'active'],
    queryFn: async () => {
      const { data } = await api.get<AiModel[]>('/api/ai/models');
      return data.filter((m) => m.active);
    },
  });
}

/**
 * Seletor de modelo de IA reutilizável (admin/ai, config do agente, follow-up).
 * Mostra só modelos ativos por padrão.
 */
export function ModelSelect({
  value,
  onChange,
  placeholder = 'Selecionar modelo',
  includeInactive = false,
}: {
  value: string | null | undefined;
  onChange: (id: string) => void;
  placeholder?: string;
  includeInactive?: boolean;
}) {
  const { data = [] } = useAiModels();
  const models = includeInactive ? data : data.filter((m) => m.active);

  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {models.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.label} {m.is_default ? '• padrão' : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
