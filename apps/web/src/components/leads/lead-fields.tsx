'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { FieldGroupList } from '@/components/fields/field-group-list';
import { LeadContactsBlock } from '@/components/fields/lead-contacts-block';
import { useFieldSchema } from '@/components/fields/use-field-schema';
import { Skeleton } from '@/components/ui/skeleton';
import {
  buildPayload,
  flattenFields,
  groupFields,
  initialValues,
  type FieldSchema,
} from '@/lib/field-render';
import { InlineField } from './inline-field';
import type { LeadDetail } from './lead-detail-types';

export interface LeadFieldsProps {
  lead: LeadDetail;
  editavel: boolean;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
}

/**
 * Campos fixos (inline) + campos PERSONALIZADOS por grupo (salvam ao mudar, sem
 * botao) + contatos vinculados.
 *
 * Divisao de trabalho: os nativos sao editados so pelos InlineField (daqui e do
 * cabecalho), um PATCH por campo; os personalizados so pelo FieldGroupList, um
 * PATCH de `dados_custom`. Nenhum dos dois escreve no territorio do outro.
 */
export function LeadFields({ lead, editavel, onPatch }: LeadFieldsProps) {
  const { schema, modo, isError } = useFieldSchema(true);
  const [values, setValues] = useState<Record<string, unknown>>({});

  // O schema traz os NATIVOS junto (o grupo de sistema: nome, telefone, email,
  // empresa, cargo, valor, temperatura) — e aqui eles ja sao os InlineField do
  // topo e do cabecalho. Renderizar o schema inteiro mostraria cada um duas
  // vezes, com dois caminhos de gravacao. `native_key` preenchida = nativo.
  const schemaCustom = useMemo<FieldSchema | undefined>(() => {
    if (!schema) return undefined;
    const fields = schema.fields.filter((f) => !f.native_key);
    const comCampo = new Set(
      fields.filter((f) => f.active && f.visible).map((f) => f.group_id),
    );
    return { ...schema, fields, groups: schema.groups.filter((g) => comCampo.has(g.id)) };
  }, [schema]);

  const defsCustom = useMemo(
    () => (schemaCustom ? flattenFields(groupFields(schemaCustom, 'LEAD')) : []),
    [schemaCustom],
  );

  useEffect(() => {
    if (!schemaCustom) return;
    setValues(initialValues(flattenFields(groupFields(schemaCustom, 'LEAD')), lead));
  }, [lead, schemaCustom]);

  const alterarCampo = (key: string, v: unknown) => {
    const next = { ...values, [key]: v };
    setValues(next);
    // SO `dados_custom`. Os nativos sao exclusivos dos InlineField: reenvia-los
    // a partir deste snapshot sobrescreveria com valor velho o que o cabecalho
    // acabou de gravar por outro caminho.
    const { custom } = buildPayload(defsCustom, next);
    // Campo personalizado nao tem onde mostrar erro no lugar (o FieldGroupList
    // nao tem slot): toast. Sem o catch a rejeicao vira unhandled rejection.
    onPatch({ dados_custom: custom }).catch((e: unknown) =>
      toast.error(e instanceof Error ? e.message : 'Não foi possível salvar'),
    );
  };

  // `undefined` no lead significa "campo vazio" para o InlineField, que so
  // conhece string | null.
  const s = (v: string | null | undefined) => (v === undefined ? null : v);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2">
        <InlineField
          label="Telefone"
          variante="phone"
          value={lead.telefone}
          disabled={!editavel}
          onSave={(v) => onPatch({ telefone: v ?? '' })}
        />
        <InlineField
          label="E-mail"
          variante="email"
          value={s(lead.email)}
          disabled={!editavel}
          onSave={(v) => onPatch({ email: v })}
        />
        <InlineField
          label="Empresa"
          variante="text"
          value={s(lead.empresa)}
          disabled={!editavel}
          onSave={(v) => onPatch({ empresa: v })}
        />
        <InlineField
          label="Cargo"
          variante="text"
          value={s(lead.cargo)}
          disabled={!editavel}
          onSave={(v) => onPatch({ cargo: v })}
        />
        {/* `valor_estimado` e Decimal no Prisma e STRING nullable no Zod: manda
            a string decimal que o InlineField devolve, sem Number(). */}
        <InlineField
          label="Valor estimado"
          variante="currency"
          value={s(lead.valor_estimado)}
          disabled={!editavel}
          onSave={(v) => onPatch({ valor_estimado: v })}
        />
      </div>

      {isError ? (
        <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
          Não foi possível carregar os campos personalizados.
        </p>
      ) : !schema ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <>
          {defsCustom.length > 0 && schemaCustom && (
            <div className={editavel ? '' : 'pointer-events-none opacity-70'}>
              <FieldGroupList
                schema={schemaCustom}
                escopo="LEAD"
                values={values}
                onChange={alterarCampo}
              />
            </div>
          )}

          {/* Contato/empresa dependem de rotas que o backend antigo nao tem —
              no modo legado o bloco some em vez de dar 404. */}
          {modo === 'completo' && (
            <div className={editavel ? '' : 'pointer-events-none opacity-70'}>
              <LeadContactsBlock leadId={lead.id} vinculos={lead.lead_contacts ?? []} schema={schema} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
