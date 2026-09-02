'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { FieldGroupList } from '@/components/fields/field-group-list';
import { LeadContactsBlock } from '@/components/fields/lead-contacts-block';
import { useFieldSchema } from '@/components/fields/use-field-schema';
import { Skeleton } from '@/components/ui/skeleton';
import { buildPayload, flattenFields, groupFields, initialValues } from '@/lib/field-render';
import { InlineField } from './inline-field';
import type { LeadDetail } from './lead-detail-types';

export interface LeadFieldsProps {
  lead: LeadDetail;
  editavel: boolean;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
}

/**
 * Campos fixos (inline) + campos personalizados por grupo (salvam ao mudar,
 * sem botao) + contatos vinculados. A separacao nativo/Json e a mesma do
 * drawer (`buildPayload`).
 */
export function LeadFields({ lead, editavel, onPatch }: LeadFieldsProps) {
  const { schema, modo, isError } = useFieldSchema(true);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const leadDefs = schema ? flattenFields(groupFields(schema, 'LEAD')) : [];

  useEffect(() => {
    if (!schema) return;
    setValues(initialValues(flattenFields(groupFields(schema, 'LEAD')), lead));
  }, [lead, schema]);

  const alterarCampo = (key: string, v: unknown) => {
    const next = { ...values, [key]: v };
    setValues(next);
    const { native, custom } = buildPayload(leadDefs, next);
    const body: Record<string, unknown> = { ...native };
    if (Object.keys(custom).length > 0) body.dados_custom = custom;
    // Campo personalizado nao tem onde mostrar erro no lugar (o FieldGroupList
    // nao tem slot): toast. Sem o catch a rejeicao vira unhandled rejection.
    onPatch(body).catch((e: unknown) =>
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
          <div className={editavel ? '' : 'pointer-events-none opacity-70'}>
            <FieldGroupList schema={schema} escopo="LEAD" values={values} onChange={alterarCampo} />
          </div>

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
