'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';

type AccountModel = 'shared' | 'individual';

export default function RegisterPage() {
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [accountModel, setAccountModel] = useState<AccountModel>('shared');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState('');
  const nomeRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const setTenant = useAuthStore((s) => s.setTenant);

  useEffect(() => {
    nomeRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsPending(true);
    setError('');
    try {
      const { data } = await api.post<{
        accessToken: string;
        user: { id: string; nome: string; email: string; role: string; tenant_id: string };
      }>('/api/auth/register', {
        nome,
        email,
        senha,
        workspace_name: workspaceName || undefined,
        account_model: accountModel,
      });
      setAuth(
        {
          id: data.user.id,
          nome: data.user.nome,
          email: data.user.email,
          role: data.user.role,
          tenantId: data.user.tenant_id,
        },
        data.accessToken,
      );
      try {
        const me = await api.get<{ user: Record<string, unknown>; tenant: { id: string; nome: string; pool_enabled: boolean } }>('/api/auth/me', {
          headers: { Authorization: `Bearer ${data.accessToken}` },
        });
        setTenant(me.data.tenant);
      } catch { /* não-crítico */ }
      router.push('/instances');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError(msg ?? 'Falha ao criar conta');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-primary" />
            <span className="text-2xl font-bold">CRM Pro</span>
          </div>
          <CardTitle className="text-2xl">Criar conta</CardTitle>
          <CardDescription>
            Crie sua conta e seu escritório. Para entrar em um escritório existente, peça ao administrador para adicionar você.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="nome">Seu nome</Label>
              <Input
                ref={nomeRef}
                id="nome"
                required
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="Maria Silva"
                disabled={isPending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="voce@empresa.com"
                disabled={isPending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="senha">Senha</Label>
              <Input
                id="senha"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                placeholder="mínimo 8 caracteres"
                disabled={isPending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="workspace">Nome do workspace (opcional)</Label>
              <Input
                id="workspace"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="Empresa Acme"
                disabled={isPending}
              />
            </div>

            <div className="space-y-2 pt-2">
              <Label>Modelo de atendimento</Label>
              <p className="text-xs text-muted-foreground">
                Define como os leads chegam pra equipe. Pode trocar depois em Configurações.
              </p>
              <div className="grid grid-cols-1 gap-2">
                <button
                  type="button"
                  onClick={() => setAccountModel('shared')}
                  disabled={isPending}
                  className={`text-left rounded-lg border px-3 py-3 transition ${
                    accountModel === 'shared'
                      ? 'border-primary bg-primary/10'
                      : 'hover:border-muted-foreground/40'
                  }`}
                >
                  <div className="text-sm font-medium">Compartilhado (1 número, vários operadores)</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Equipe atende leads de um único WhatsApp. Operadores assumem leads do pool.
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setAccountModel('individual')}
                  disabled={isPending}
                  className={`text-left rounded-lg border px-3 py-3 transition ${
                    accountModel === 'individual'
                      ? 'border-primary bg-primary/10'
                      : 'hover:border-muted-foreground/40'
                  }`}
                >
                  <div className="text-sm font-medium">Individual (1 número por operador)</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Cada operador conecta seu próprio WhatsApp. Super-admin delega leads via Kanban.
                  </div>
                </button>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="text-sm text-destructive border border-destructive/20 bg-destructive/10 px-3 py-2 rounded-md"
              >
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={isPending}>
              {isPending ? 'Criando...' : 'Criar conta'}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-center">
          <span className="text-sm text-muted-foreground">
            Já tem conta?{' '}
            <a href="/login" className="text-primary hover:underline font-medium">
              Entrar
            </a>
          </span>
        </CardFooter>
      </Card>
    </div>
  );
}
