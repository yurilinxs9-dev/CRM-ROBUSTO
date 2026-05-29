import { CheckCircle } from 'lucide-react';

const FEATURES = [
  'Multi-instância WhatsApp',
  'Kanban drag-and-drop',
  'Chat espelhado em tempo real',
  'Métricas e dashboards',
] as const;

/** Logo CRM Pro reutilizável (quadrado verde com "C"). */
export function AuthLogo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-12 w-12 rounded-2xl' : size === 'sm' ? 'h-9 w-9 rounded-lg' : 'h-10 w-10 rounded-xl';
  const text = size === 'lg' ? 'text-xl' : 'text-base';
  const label = size === 'lg' ? 'text-3xl' : 'text-2xl';
  return (
    <div className="flex items-center gap-3">
      <div className={`flex items-center justify-center bg-primary shadow-lg shadow-primary/20 ${box}`}>
        <span className={`font-bold text-primary-foreground ${text}`}>C</span>
      </div>
      <span className={`font-bold tracking-tight ${label}`}>CRM Pro</span>
    </div>
  );
}

/**
 * Painel de marca lateral das telas de auth (login/register). Split-screen no
 * desktop (md+), oculto no mobile. Compartilhado para consistência.
 */
export function AuthBranding({ headline }: { headline?: string }) {
  return (
    <aside className="relative hidden w-1/2 flex-col justify-between overflow-hidden border-r border-border bg-gradient-to-br from-background via-background to-primary/10 p-12 md:flex">
      <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute bottom-0 left-0 h-72 w-72 rounded-full bg-primary/5 blur-3xl" />

      <div className="relative">
        <AuthLogo size="lg" />
      </div>

      <div className="relative max-w-md space-y-8">
        <h2 className="text-4xl font-bold leading-tight">
          {headline ?? 'Gerencie seu funil de vendas com WhatsApp em tempo real'}
        </h2>
        <ul className="space-y-4">
          {FEATURES.map((feature) => (
            <li key={feature} className="flex items-center gap-3 text-base text-muted-foreground">
              <CheckCircle className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-sm text-muted-foreground">© 2026 CRM Pro</p>
    </aside>
  );
}
