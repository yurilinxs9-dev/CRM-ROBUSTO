'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Handshake, Kanban, Target } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { canAccessPlSales } from '@/lib/pl-sales';
import { cn } from '@/lib/cn';

export default function ConsorcioPlLayout({ children }: { children: React.ReactNode }) {
  const user = useAuthStore(state => state.user);
  const pathname = usePathname();
  if (!user || !canAccessPlSales(user.tenantId, user.role)) return <div className="p-8"><h1 className="text-xl font-semibold">Área indisponível</h1><p className="mt-2 text-muted-foreground">Seu acesso não inclui a área Consórcio PL.</p></div>;
  return <div key={`${user.tenantId}:${user.id}:${user.role}`} className="flex h-full min-h-0 flex-col">
    <header className="shrink-0 space-y-3 border-b px-4 py-4 sm:px-6">
      <div><h1 className="flex items-center gap-2 text-xl font-semibold"><Handshake className="h-5 w-5 text-emerald-600" />Consórcio PL</h1><p className="mt-1 text-sm text-muted-foreground">Leads, vendas próprias e metas. A distribuição dos leads é feita pela gestão.</p></div>
      <nav aria-label="Áreas do Consórcio PL" className="flex flex-wrap gap-2">
        {[
          { href: '/consorcio-pl', label: 'Leads do consórcio', icon: Kanban },
          { href: '/consorcio-pl/vendas', label: 'Vendas da PL e metas', icon: Target },
        ].map(({ href, label, icon: Icon }) => <Link key={href} href={href} aria-current={pathname === href ? 'page' : undefined} className={cn('inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', pathname === href ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground')}><Icon className="h-4 w-4" />{label}</Link>)}
      </nav>
    </header>
    <div className="min-h-0 flex-1 overflow-auto">{children}</div>
  </div>;
}
