'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { FieldGroupList } from '@/components/fields/field-group-list';
import { useFieldSchema } from '@/components/fields/use-field-schema';
import { groupFields, flattenFields, initialValues, buildPayload } from '@/lib/field-render';
import type { Stage } from './stage-column';

export interface NewLeadFormData {
  nome: string;
  telefone: string;
  estagio_id: string;
  [key: string]: unknown;
}

interface NewLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stages: Stage[];
  defaultStageId?: string | null;
  isLoading?: boolean;
  onSubmit: (data: NewLeadFormData) => void;
}

/**
 * Criação de lead guiada pelo schema de campos do tenant — os mesmos campos
 * que a empresa configurou na aba Configurações da ficha aparecem aqui.
 *
 * Antes eram cinco campos fixos, então um campo personalizado obrigatório para
 * o negócio só podia ser preenchido depois de criar o lead.
 *
 * `estagio_id` fica de fora do schema de propósito: é posição no funil, não
 * atributo do lead.
 */
export function NewLeadDialog({
  open,
  onOpenChange,
  stages,
  defaultStageId,
  isLoading,
  onSubmit,
}: NewLeadDialogProps) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [stageId, setStageId] = useState<string>('');

  const { schema, isError } = useFieldSchema(open);

  const defs = schema ? flattenFields(groupFields(schema, 'LEAD')) : [];

  useEffect(() => {
    if (!open || !schema) return;
    setValues(initialValues(flattenFields(groupFields(schema, 'LEAD')), null));
    setStageId(defaultStageId ?? stages[0]?.id ?? '');
  }, [open, schema, defaultStageId, stages]);

  const alterar = (key: string, v: unknown) => setValues((p) => ({ ...p, [key]: v }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!stageId) return;
    const { native, custom } = buildPayload(defs, values);
    // O backend exige os dois; buildPayload omite nativo obrigatório vazio, e é
    // essa ausência que este guard detecta.
    if (!native.nome || !native.telefone) return;
    const body: NewLeadFormData = {
      ...native,
      nome: String(native.nome),
      telefone: String(native.telefone),
      estagio_id: stageId,
    };
    if (Object.keys(custom).length > 0) body.dados_custom = custom;
    onSubmit(body);
  };

  const { native: previa } = buildPayload(defs, values);
  const podeEnviar = !!previa.nome && !!previa.telefone && !!stageId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo Lead</DialogTitle>
          <DialogDescription>Adicione um novo lead ao pipeline.</DialogDescription>
        </DialogHeader>

        {isError ? (
          <p className="rounded-md border border-destructive/40 px-3 py-4 text-sm text-destructive">
            Não foi possível carregar os campos. O servidor da API parece estar numa versão
            anterior à do site — atualize o backend e recarregue.
          </p>
        ) : !schema ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <FieldGroupList
              schema={schema}
              escopo="LEAD"
              values={values}
              onChange={alterar}
            />

            <div className="space-y-1.5">
              <Label>Estágio</Label>
              <Select value={stageId} onValueChange={setStageId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione" />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isLoading}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={isLoading || !podeEnviar}>
                {isLoading ? 'Criando...' : 'Criar Lead'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
