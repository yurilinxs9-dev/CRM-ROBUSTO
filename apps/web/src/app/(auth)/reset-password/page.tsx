'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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
import { AuthBranding, AuthLogo } from '@/components/layout/auth-branding';
import { api } from '@/lib/api';

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const router = useRouter();
  const [senha, setSenha] = useState('');
  const [confirma, setConfirma] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (senha.length < 8) {
      setError('A senha precisa de pelo menos 8 caracteres');
      return;
    }
    if (senha !== confirma) {
      setError('As senhas não conferem');
      return;
    }
    setIsPending(true);
    try {
      await api.post('/api/auth/reset-password', { token, senha });
      setDone(true);
      setTimeout(() => router.push('/login'), 2500);
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data
        ?.message;
      setError(msg ?? 'Token inválido ou expirado — solicite um novo link');
    } finally {
      setIsPending(false);
    }
  };

  if (!token) {
    return (
      <div className="text-sm text-destructive border border-destructive/20 bg-destructive/10 px-3 py-3 rounded-md">
        Link inválido — solicite a redefinição novamente em{' '}
        <a href="/forgot-password" className="underline">
          esqueci minha senha
        </a>
        .
      </div>
    );
  }

  if (done) {
    return (
      <div className="text-sm border border-primary/20 bg-primary/10 px-3 py-3 rounded-md">
        Senha redefinida! Redirecionando pro login…
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="senha">Nova senha</Label>
        <Input
          id="senha"
          type="password"
          autoComplete="new-password"
          required
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          placeholder="••••••••"
          disabled={isPending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirma">Confirmar nova senha</Label>
        <Input
          id="confirma"
          type="password"
          autoComplete="new-password"
          required
          value={confirma}
          onChange={(e) => setConfirma(e.target.value)}
          placeholder="••••••••"
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
        {isPending ? 'Salvando...' : 'Redefinir senha'}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <AuthBranding />
      <main className="w-full md:w-1/2 flex items-center justify-center p-6 sm:p-12">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-2">
            <div className="md:hidden mb-2">
              <AuthLogo />
            </div>
            <CardTitle className="text-2xl">Nova senha</CardTitle>
            <CardDescription>Defina a nova senha da sua conta.</CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={null}>
              <ResetPasswordForm />
            </Suspense>
          </CardContent>
          <CardFooter className="justify-center">
            <a href="/login" className="text-sm text-primary hover:underline">
              Voltar pro login
            </a>
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}
