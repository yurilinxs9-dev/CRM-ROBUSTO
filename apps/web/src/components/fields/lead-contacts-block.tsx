'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Unlink, Building2, UserRound, Save, Star } from 'lucide-react';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { FieldGroupList } from './field-group-list';
import {
  groupFields,
  flattenFields,
  initialValues,
  buildPayload,
  type FieldSchema,
  type FieldRecord,
} from '@/lib/field-render';

interface Company extends FieldRecord {
  id: string;
  nome: string;
}

interface Contact extends FieldRecord {
  id: string;
  nome: string;
  company_id?: string | null;
  company?: Company | null;
}

interface LeadContactLink {
  contact_id: string;
  is_principal: boolean;
  contact: Contact;
}

function erroDe(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
  return msg ?? fallback;
}

/** Formulário de um registro (contato ou empresa) guiado pelo schema. */
function RegistroEditavel({
  schema,
  escopo,
  registro,
  onSalvar,
  salvando,
}: {
  schema: FieldSchema;
  escopo: 'CONTATO' | 'EMPRESA';
  registro: FieldRecord;
  onSalvar: (body: Record<string, unknown>) => void;
  salvando: boolean;
}) {
  const defs = flattenFields(groupFields(schema, escopo));
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initialValues(defs, registro),
  );
  const [dirty, setDirty] = useState(false);

  const alterar = (key: string, v: unknown) => {
    setValues((p) => ({ ...p, [key]: v }));
    setDirty(true);
  };

  const salvar = () => {
    const { native, custom } = buildPayload(defs, values);
    const body: Record<string, unknown> = { ...native };
    if (Object.keys(custom).length > 0) body.dados_custom = custom;
    onSalvar(body);
    setDirty(false);
  };

  return (
    <div className="space-y-3">
      <FieldGroupList schema={schema} escopo={escopo} values={values} onChange={alterar} />
      {dirty && (
        <Button size="sm" variant="outline" onClick={salvar} disabled={salvando}>
          <Save className="mr-1 h-3.5 w-3.5" />
          {salvando ? 'Salvando…' : 'Salvar'}
        </Button>
      )}
    </div>
  );
}

export function LeadContactsBlock({
  leadId,
  vinculos,
  schema,
}: {
  leadId: string;
  vinculos: LeadContactLink[];
  schema: FieldSchema;
}) {
  const qc = useQueryClient();
  const [abrirVincular, setAbrirVincular] = useState(false);
  const [busca, setBusca] = useState('');
  const [nomeNovo, setNomeNovo] = useState('');

  const invalidar = () => {
    void qc.invalidateQueries({ queryKey: ['lead', leadId] });
  };

  const { data: candidatos = [] } = useQuery<Contact[]>({
    queryKey: ['contacts', busca],
    queryFn: async () => (await api.get('/api/contacts', { params: { q: busca || undefined } })).data,
    enabled: abrirVincular,
  });

  const { data: empresas = [] } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: async () => (await api.get('/api/companies')).data,
  });

  const vincular = useMutation({
    mutationFn: async (contactId: string) =>
      api.post(`/api/leads/${leadId}/contacts`, { contact_id: contactId }),
    onSuccess: () => {
      invalidar();
      setAbrirVincular(false);
      toast.success('Contato vinculado');
    },
    onError: (e) => toast.error(erroDe(e, 'Erro ao vincular contato')),
  });

  const criarEVincular = useMutation({
    mutationFn: async (nome: string) => {
      const { data } = await api.post('/api/contacts', { nome });
      await api.post(`/api/leads/${leadId}/contacts`, { contact_id: data.id, is_principal: true });
    },
    onSuccess: () => {
      invalidar();
      setAbrirVincular(false);
      setNomeNovo('');
      toast.success('Contato criado e vinculado');
    },
    onError: (e) => toast.error(erroDe(e, 'Erro ao criar contato')),
  });

  const desvincular = useMutation({
    mutationFn: async (contactId: string) =>
      api.delete(`/api/leads/${leadId}/contacts/${contactId}`),
    onSuccess: () => {
      invalidar();
      toast.success('Contato desvinculado');
    },
    onError: (e) => toast.error(erroDe(e, 'Erro ao desvincular')),
  });

  const salvarContato = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/api/contacts/${id}`, body),
    onSuccess: () => {
      invalidar();
      toast.success('Contato atualizado');
    },
    onError: (e) => toast.error(erroDe(e, 'Erro ao salvar contato')),
  });

  const salvarEmpresa = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/api/companies/${id}`, body),
    onSuccess: () => {
      invalidar();
      void qc.invalidateQueries({ queryKey: ['companies'] });
      toast.success('Empresa atualizada');
    },
    onError: (e) => toast.error(erroDe(e, 'Erro ao salvar empresa')),
  });

  const trocarEmpresa = useMutation({
    mutationFn: async ({ contactId, companyId }: { contactId: string; companyId: string | null }) =>
      api.patch(`/api/contacts/${contactId}`, { company_id: companyId }),
    onSuccess: () => {
      invalidar();
      toast.success('Empresa vinculada');
    },
    onError: (e) => toast.error(erroDe(e, 'Erro ao vincular empresa')),
  });

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <UserRound className="h-3.5 w-3.5" />
          Contatos
        </p>
        <Button variant="ghost" size="sm" onClick={() => setAbrirVincular(true)}>
          <Plus size={13} className="mr-1" /> Vincular
        </Button>
      </div>

      {vinculos.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
          Nenhum contato vinculado. Leads antigos não têm contato — vincule um quando precisar
          separar a pessoa do negócio.
        </p>
      ) : (
        vinculos.map((v) => (
          <div key={v.contact_id} className="space-y-4 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <span className="truncate">{v.contact.nome}</span>
                {v.is_principal && (
                  <Star size={11} className="shrink-0 fill-current text-amber-500" />
                )}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-destructive"
                title="Desvincular"
                onClick={() => desvincular.mutate(v.contact_id)}
              >
                <Unlink size={13} />
              </Button>
            </div>

            <RegistroEditavel
              schema={schema}
              escopo="CONTATO"
              registro={v.contact}
              salvando={salvarContato.isPending}
              onSalvar={(body) => salvarContato.mutate({ id: v.contact.id, body })}
            />

            {/* Empresa do contato */}
            <div className="space-y-2 border-t pt-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Building2 className="h-3.5 w-3.5" />
                Empresa
              </p>
              <Select
                value={v.contact.company_id ?? '__nenhuma__'}
                onValueChange={(val) =>
                  trocarEmpresa.mutate({
                    contactId: v.contact.id,
                    companyId: val === '__nenhuma__' ? null : val,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Nenhuma" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__nenhuma__">
                    <span className="text-muted-foreground">Nenhuma</span>
                  </SelectItem>
                  {empresas.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {v.contact.company && (
                <RegistroEditavel
                  schema={schema}
                  escopo="EMPRESA"
                  registro={v.contact.company}
                  salvando={salvarEmpresa.isPending}
                  onSalvar={(body) => salvarEmpresa.mutate({ id: v.contact.company!.id, body })}
                />
              )}
            </div>
          </div>
        ))
      )}

      <Dialog open={abrirVincular} onOpenChange={setAbrirVincular}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Vincular contato</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ct-busca">Buscar contato existente</Label>
              <Input
                id="ct-busca"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Nome, e-mail ou telefone"
              />
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {candidatos.length === 0 ? (
                  <p className="py-2 text-xs text-muted-foreground">Nenhum contato encontrado.</p>
                ) : (
                  candidatos.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => vincular.mutate(c.id)}
                      className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                    >
                      <span className="truncate">{c.nome}</span>
                      {c.company?.nome && (
                        <Badge variant="outline" className="ml-2 shrink-0 text-[10px]">
                          {c.company.nome}
                        </Badge>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="space-y-2 border-t pt-3">
              <Label htmlFor="ct-novo">Ou criar um novo</Label>
              <div className="flex gap-2">
                <Input
                  id="ct-novo"
                  value={nomeNovo}
                  onChange={(e) => setNomeNovo(e.target.value)}
                  placeholder="Nome do contato"
                />
                <Button
                  onClick={() => criarEVincular.mutate(nomeNovo.trim())}
                  disabled={!nomeNovo.trim() || criarEVincular.isPending}
                >
                  Criar
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAbrirVincular(false)}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
