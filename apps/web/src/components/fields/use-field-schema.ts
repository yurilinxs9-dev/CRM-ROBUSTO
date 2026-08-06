'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { schemaFromLegacy, type FieldSchema, type LegacyFieldDef } from '@/lib/field-render';

export type ModoSchema = 'completo' | 'legado';

/**
 * Carrega o schema de campos, tolerando backend desatualizado.
 *
 * A ficha nova depende de `GET /custom-fields/schema`, que só existe no backend
 * novo. A Vercel publica o frontend sozinha no push, mas o backend roda em
 * container no VPS e sobe por outro caminho — então existe uma janela em que o
 * site é novo e a API é velha. Sem isto, a ficha inteira ficava inutilizável
 * nessa janela.
 *
 * No modo `legado` a UI cai para `GET /custom-fields` (que existe desde julho) e
 * monta o schema no cliente. Contato, empresa, grupos e reordenação somem da
 * tela, porque dependem de rotas que aquele backend não tem — melhor ausente do
 * que presente dando 404.
 */
export function useFieldSchema(enabled = true): {
  schema: FieldSchema | undefined;
  modo: ModoSchema;
  isLoading: boolean;
  isError: boolean;
} {
  const completo = useQuery<FieldSchema>({
    queryKey: ['custom-fields-schema'],
    queryFn: async () => (await api.get('/api/custom-fields/schema')).data,
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const legado = useQuery<FieldSchema>({
    queryKey: ['custom-fields-legado'],
    queryFn: async () => {
      const { data } = await api.get('/api/custom-fields');
      return schemaFromLegacy((data ?? []) as LegacyFieldDef[]);
    },
    // Só entra em cena quando a rota nova falhou.
    enabled: enabled && completo.isError,
    staleTime: 5 * 60 * 1000,
  });

  if (completo.data) {
    return { schema: completo.data, modo: 'completo', isLoading: false, isError: false };
  }
  if (completo.isError) {
    return {
      schema: legado.data,
      modo: 'legado',
      isLoading: legado.isLoading,
      isError: legado.isError,
    };
  }
  return { schema: undefined, modo: 'completo', isLoading: completo.isLoading, isError: false };
}
