'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Check } from 'lucide-react';
import { api } from '@/lib/api';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const ALL_SCOPES = [
  { value: 'contacts:read',       label: 'Ler contatos (GET /users)' },
  { value: 'contacts:write',      label: 'Criar/editar contatos' },
  { value: 'conversations:read',  label: 'Ler conversas' },
  { value: 'conversations:write', label: 'Enviar mensagens / mudar status' },
  { value: 'tags:write',          label: 'Adicionar etiquetas' },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

interface CreatedKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  token: string;
}

export function ApiKeyFormDialog({ open, onClose }: Props) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [isAi, setIsAi] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setScopes([]);
      setIsAi(false);
      setCreated(null);
      setCopied(false);
    }
  }, [open]);

  const mut = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<CreatedKey>('/api/api-keys', {
        name: name.trim(),
        scopes,
        is_ai: isAi,
      });
      return data;
    },
    onSuccess: (data) => {
      setCreated(data);
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(typeof msg === 'string' ? msg : 'Erro ao criar chave');
    },
  });

  const copy = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.token);
    setCopied(true);
    toast.success('Token copiado');
    setTimeout(() => setCopied(false), 2000);
  };

  const valid = name.trim().length > 0 && scopes.length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{created ? 'Chave criada' : 'Nova API key'}</DialogTitle>
        </DialogHeader>

        {!created ? (
          <>
            <div className="space-y-4 py-2">
              <div>
                <Label>Nome da integração</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex: n8n - automação atendimento"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                />
              </div>

              <div>
                <Label>Permissões (escopos)</Label>
                <div className="space-y-2 mt-2">
                  {ALL_SCOPES.map((sc) => {
                    const checked = scopes.includes(sc.value);
                    return (
                      <label key={sc.value} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-input"
                          checked={checked}
                          onChange={(e) => {
                            setScopes(
                              e.target.checked
                                ? [...scopes, sc.value]
                                : scopes.filter((x) => x !== sc.value),
                            );
                          }}
                        />
                        <span className="text-sm">{sc.label}</span>
                        <code className="text-xs text-muted-foreground ml-auto">{sc.value}</code>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-md border p-3">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-4 w-4 mt-0.5 rounded border-input"
                    checked={isAi}
                    onChange={(e) => setIsAi(e.target.checked)}
                  />
                  <span className="text-sm">
                    Esta chave é de um <strong>serviço de IA</strong>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      Mensagens enviadas por esta chave são marcadas como IA e respeitam o
                      bloqueio automático quando um humano assume a conversa. Deixe desmarcado
                      para integrações comuns (n8n, Zapier).
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancelar</Button>
              <Button onClick={() => mut.mutate()} disabled={!valid || mut.isPending}>
                {mut.isPending ? 'Criando...' : 'Criar chave'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-4 py-2">
              <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
                Copie o token agora — ele <strong>não será exibido novamente</strong>.
                Guarde em local seguro.
              </div>

              <div>
                <Label>Token</Label>
                <div className="flex gap-2 mt-1">
                  <code className="flex-1 min-w-0 break-all text-xs font-mono bg-secondary rounded p-2">
                    {created.token}
                  </code>
                  <Button size="icon" variant="outline" onClick={copy} title="Copiar">
                    {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </div>

              <div className="text-xs text-muted-foreground space-y-1">
                <div><strong>Como usar:</strong></div>
                <code className="block bg-secondary rounded p-2 break-all">
                  curl https://SEU_DOMINIO/api/v1/users \<br />
                  &nbsp;&nbsp;-H "Authorization: Bearer {created.prefix}..."
                </code>
              </div>
            </div>

            <DialogFooter>
              <Button onClick={onClose}>Concluir</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
