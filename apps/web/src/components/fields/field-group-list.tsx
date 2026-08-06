'use client';

import { FieldRow } from './field-input';
import {
  groupFields,
  readValue,
  type FieldDef,
  type FieldScope,
  type FieldSchema,
  type FieldRecord,
} from '@/lib/field-render';

interface FieldGroupListProps {
  schema: FieldSchema;
  escopo: FieldScope;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  /** Some com o título quando o escopo tem só o grupo de sistema. */
  ocultarTituloUnico?: boolean;
}

/**
 * Desenha os campos de um escopo agrupados nas abas que a empresa criou.
 * Grupo sem campo visível não aparece — evita título solto na ficha.
 */
export function FieldGroupList({
  schema,
  escopo,
  values,
  onChange,
  ocultarTituloUnico = true,
}: FieldGroupListProps) {
  const grupos = groupFields(schema, escopo).filter((g) => g.fields.length > 0);
  if (grupos.length === 0) return null;

  const semTitulo = ocultarTituloUnico && grupos.length === 1 && grupos[0].is_system;

  return (
    <div className="space-y-5">
      {grupos.map((grupo) => (
        <section key={grupo.id} className="space-y-3">
          {!semTitulo && (
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {grupo.nome}
            </p>
          )}
          {grupo.fields.map((def) => (
            <FieldRow
              key={def.id}
              def={def}
              value={values[def.key]}
              onChange={(v) => onChange(def.key, v)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/** Formata um valor para leitura, conforme o tipo declarado. */
function formatar(def: FieldDef, valor: unknown): string | null {
  if (valor === null || valor === undefined || valor === '') return null;
  switch (def.tipo) {
    case 'boolean':
      return valor === true ? 'Sim' : 'Não';
    case 'multiselect':
      return Array.isArray(valor) && valor.length > 0 ? valor.join(', ') : null;
    case 'currency': {
      const n = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'));
      return Number.isFinite(n)
        ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
        : String(valor);
    }
    case 'date': {
      const d = new Date(String(valor));
      return Number.isNaN(d.getTime())
        ? String(valor)
        : d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    }
    default:
      return String(valor);
  }
}

/**
 * Versão somente leitura, para o painel do chat — que é vista rápida, não
 * formulário. Duplicar a edição ali significaria duas cópias da lógica de save.
 * Campo sem valor não aparece, pra ficha curta não virar lista de vazios.
 */
export function FieldGroupView({
  schema,
  escopo,
  registro,
}: {
  schema: FieldSchema;
  escopo: FieldScope;
  registro: FieldRecord | null | undefined;
}) {
  const grupos = groupFields(schema, escopo)
    .map((g) => ({
      ...g,
      linhas: g.fields
        .map((def) => ({ def, texto: formatar(def, readValue(def, registro)) }))
        .filter((l) => l.texto !== null),
    }))
    .filter((g) => g.linhas.length > 0);

  if (grupos.length === 0) return null;
  const semTitulo = grupos.length === 1 && grupos[0].is_system;

  return (
    <div className="space-y-5">
      {grupos.map((grupo) => (
        <section key={grupo.id} className="space-y-3">
          {!semTitulo && (
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {grupo.nome}
            </p>
          )}
          {grupo.linhas.map(({ def, texto }) => (
            <div key={def.id} className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {def.nome}
              </p>
              <p className="break-words text-sm text-foreground">{texto}</p>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
