'use client';

import { useState } from 'react';
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

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsPending(true);
    try {
      await api.post('/api/auth/forgot-password', { email });
    } catch {
      /* resposta é sempre genérica — não vaza se o email existe */
    } finally {
      setSent(true);
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
            <CardTitle className="text-2xl">Recuperar senha</CardTitle>
            <CardDescription>
              Informe seu e-mail e enviaremos um link de redefinição.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <div className="text-sm border border-primary/20 bg-primary/10 px-3 py-3 rounded-md">
                Se o e-mail existir, um link de redefinição foi enviado. Confira sua
                caixa de entrada (e o spam).
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" noValidate>
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
                <Button type="submit" className="w-full" disabled={isPending || !email}>
                  {isPending ? 'Enviando...' : 'Enviar link de redefinição'}
                </Button>
              </form>
            )}
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
