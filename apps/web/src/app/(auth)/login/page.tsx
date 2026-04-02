'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { data } = await api.post('/api/auth/login', { email, senha });
      const { data: me } = await api.get('/api/auth/me', {
        headers: { Authorization: `Bearer ${data.accessToken}` },
      });
      setAuth(me, data.accessToken);
      router.push('/kanban');
    } catch {
      setError('Email ou senha inválidos');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
      <div className="w-full max-w-sm p-8 rounded-2xl border" style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}>
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-lg"
            style={{ background: 'var(--primary)' }}>
            C
          </div>
          <div>
            <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>CRM WhatsApp</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Gestão de leads</p>
          </div>
        </div>

        <h1 className="text-xl font-semibold mb-6" style={{ color: 'var(--text-primary)' }}>
          Entrar na conta
        </h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm mb-1.5" style={{ color: 'var(--text-secondary)' }}>Email</label>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              className="w-full h-10 px-3 rounded-lg text-sm outline-none transition-colors"
              style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              placeholder="admin@crm.com"
            />
          </div>
          <div>
            <label className="block text-sm mb-1.5" style={{ color: 'var(--text-secondary)' }}>Senha</label>
            <input
              type="password" value={senha} onChange={(e) => setSenha(e.target.value)} required
              className="w-full h-10 px-3 rounded-lg text-sm outline-none"
              style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-sm px-3 py-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--danger)' }}>
              {error}
            </p>
          )}

          <button type="submit" disabled={loading}
            className="w-full h-10 rounded-lg text-sm font-medium text-white transition-opacity disabled:opacity-60"
            style={{ background: 'var(--primary)' }}>
            {loading ? 'Entrando...' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}
