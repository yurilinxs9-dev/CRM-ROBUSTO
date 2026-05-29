'use client';

import { ShieldAlert } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Faixa fixa enquanto o admin de plataforma navega como um cliente.
 * "Voltar" restaura a sessão do admin (recarrega com o token original).
 */
export function ImpersonationBanner() {
  const impersonating = useAuthStore((s) => s.impersonating);
  const user = useAuthStore((s) => s.user);
  const stop = useAuthStore((s) => s.stopImpersonation);

  if (!impersonating) return null;

  return (
    <div
      className="flex items-center gap-3 border-b px-4 py-2 text-sm md:px-6"
      style={{ background: 'rgba(245,158,11,0.15)', borderColor: 'rgba(245,158,11,0.4)', color: '#f59e0b' }}
    >
      <ShieldAlert size={16} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        Você está vendo como <strong>{user?.nome}</strong> ({user?.email})
      </span>
      <button
        type="button"
        onClick={() => {
          stop();
          // Reload completo pra recarregar todas as queries com o token do admin.
          window.location.href = '/admin';
        }}
        className="shrink-0 rounded-md border border-current px-2.5 py-1 text-xs font-medium hover:bg-amber-500/10"
      >
        Voltar ao admin
      </button>
    </div>
  );
}
