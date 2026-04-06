'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle } from 'lucide-react';
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

const FEATURES = [
  'Multi-instância WhatsApp',
  'Kanban drag-and-drop',
  'Chat espelhado em tempo real',
  'Métricas e dashboards',
] as const;

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsPending(true);
    setError('');
    try {
      const { data } = await api.post<{ accessToken: string }>('/api/auth/login', { email, senha });
      const token = data.accessToken;
      const payloadB64 = token.split('.')[1] ?? '';
      const payloadJson =
        typeof window !== 'undefined'
          ? atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))
          : Buffer.from(payloadB64, 'base64').toString('utf-8');
      const payload = JSON.parse(payloadJson) as { sub: string; email: string; role: string; tenantId: string };
      setAuth(
        {
          id: payload.sub,
          email: payload.email,
          role: payload.role,
          tenantId: payload.tenantId,
          nome: payload.email.split('@')[0],
        },
        token,
      );
      router.push('/dashboard');
    } catch {
      setError('Email ou senha inválidos');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside className="hidden md:flex md:w-1/2 flex-col justify-between p-12 bg-gradient-to-br from-background via-background to-primary/10 border-r border-border relative overflow-hidden">
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-72 h-72 rounded-full bg-primary/5 blur-3xl pointer-events-none" />

        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-primary shadow-lg shadow-primary/20" />
            <span className="text-3xl font-bold tracking-tight">CRM Pro</span>
          </div>
        </div>

        <div className="relative space-y-8 max-w-md">
          <h2 className="text-4xl font-bold leading-tight">
            Gerencie seu funil de vendas com WhatsApp em tempo real
          </h2>
          <ul className="space-y-4">
            {FEATURES.map((feature) => (
              <li key={feature} className="flex items-center gap-3 text-base text-muted-foreground">
                <CheckCircle className="w-5 h-5 text-primary shrink-0" aria-hidden="true" />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-sm text-muted-foreground">© 2026 CRM Pro</p>
      </aside>

      <main className="w-full md:w-1/2 flex items-center justify-center p-6 sm:p-12">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-2">
            <div className="flex md:hidden items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-primary" />
              <span className="text-2xl font-bold">CRM Pro</span>
            </div>
            <CardTitle className="text-2xl">Bem-vindo de volta</CardTitle>
            <CardDescription>Entre com suas credenciais</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  ref={emailRef}
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="voce@empresa.com"
                  aria-label="Email"
                  aria-invalid={error ? true : undefined}
                  disabled={isPending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="senha">Senha</Label>
                <Input
                  id="senha"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  placeholder="••••••••"
                  aria-label="Senha"
                  aria-invalid={error ? true : undefined}
                  disabled={isPending}
                />
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
                {isPending ? 'Entrando...' : 'Entrar'}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="justify-center">
            <span className="text-sm text-muted-foreground">
              Não tem conta?{' '}
              <a href="/register" className="text-primary hover:underline font-medium">
                Criar agora
              </a>
            </span>
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}
