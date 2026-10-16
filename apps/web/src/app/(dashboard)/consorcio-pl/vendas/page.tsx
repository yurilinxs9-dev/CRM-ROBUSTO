'use client';

import { useState } from 'react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { saoPauloDate } from '@/lib/partners';
import { plSalesKey } from '@/lib/pl-sales';
import { PlSalesDashboard } from '@/components/pl-sales/pl-sales-dashboard';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/partners/partner-forms';

export default function PlSalesPage() {
  const user = useAuthStore(state => state.user);
  const qc = useQueryClient();
  const [month, setMonth] = useState(() => saoPauloDate().slice(0, 7));
  const key = plSalesKey(user?.tenantId ?? '', user?.id ?? '', user?.role ?? '');
  const refreshing = useIsFetching({ queryKey: key }) > 0;
  if (!user) return null;
  return <main className="mx-auto w-full max-w-[1600px] space-y-6 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-2xl font-semibold">Vendas da PL</h2><p className="mt-1 text-sm text-muted-foreground">Contratos fechados, crédito contratado e metas mensais da equipe.</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <input type="month" aria-label="Mês do relatório" className={`${fieldClass} w-auto`} min="2000-01" max="2100-12" value={month} onChange={event => { if (/^\d{4}-\d{2}$/.test(event.target.value)) setMonth(event.target.value); }} />
        <Button variant="outline" size="icon" aria-label="Atualizar dados" title="Atualizar dados" disabled={refreshing} onClick={() => void qc.invalidateQueries({ queryKey: key })}><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /></Button>
      </div>
    </header>
    <PlSalesDashboard key={month} month={month} tenant={user.tenantId} userId={user.id} role={user.role} />
  </main>;
}
