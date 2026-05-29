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
  Switch,
} from '@/components/ui';
import { AuthBranding, AuthLogo } from '@/components/layout/auth-branding';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [remember, setRemember] = useState(true);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const setTenant = useAuthStore((s) => s.setTenant);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsPending(true);
    setError('');
    try {
      const { data } = await api.post<{ accessToken: string }>('/api/auth/login', {
        email,
        senha,
        remember,
      });
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
      try {
        const me = await api.get<{ user: Record<string, unknown>; tenant: { id: string; nome: string; pool_enabled: boolean } }>('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        setTenant(me.data.tenant);
      } catch { /* não-crítico — pool_enabled fica false por default */ }
      router.push('/dashboard');
    } catch {
      setError('Email ou senha inválidos');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <AuthBranding />

      <main className="w-full md:w-1/2 flex items-center justify-center p-6 sm:p-12">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-2">
            <div className="md:hidden mb-2">
              <AuthLogo />
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

              <div className="flex items-center justify-between gap-3 pt-1">
                <Label
                  htmlFor="remember"
                  className="flex items-center gap-2 text-sm font-normal text-muted-foreground cursor-pointer select-none"
                >
                  <Switch
                    id="remember"
                    checked={remember}
                    onCheckedChange={setRemember}
                    disabled={isPending}
                    aria-label="Manter conectado"
                  />
                  Manter conectado neste dispositivo
                </Label>
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
              <p className="text-center text-xs text-muted-foreground">
                Faz parte de um escritório? Peça ao administrador para criar seu acesso.
              </p>
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
