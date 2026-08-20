'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Megaphone, Pencil, Search, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import {
  channelMeta,
  percentFmt,
  type AttributionBucket,
  type AttributionCampaigns,
  type AttributionSummary,
  type CampaignRow,
} from '@/lib/attribution';

const numberFmt = new Intl.NumberFormat('pt-BR');
const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

// Mesmo card das outras seções de /analytics. Duplicado aqui porque o
// SectionCard da página é local a ela — exportá-lo mexeria num arquivo de
// 1.300 linhas que já funciona.
function SectionCard({
  title,
  icon: Icon,
  children,
  action,
}: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="rounded-xl border p-5 transition-colors hover:border-[var(--border-strong)]"
      style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
    >
      <div className="flex items-center gap-2 mb-5">
        <Icon size={16} style={{ color: 'var(--text-muted)' }} />
        <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h3>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </div>
  );
}

/** Colunas de métrica, iguais nas três tabelas. */
function MetricCells({ row }: { row: AttributionBucket }) {
  return (
    <>
      <td className="py-2 px-3 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {numberFmt.format(row.leads)}
      </td>
      <td className="py-2 px-3 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {numberFmt.format(row.won)}
      </td>
      <td className="py-2 px-3 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {percentFmt(row.conversion_rate)}
      </td>
      <td className="py-2 px-3 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {brlFmt.format(row.won_value)}
      </td>
    </>
  );
}

function TableHead({ first }: { first: string }) {
  return (
    <thead>
      <tr
        className="text-[11px] uppercase tracking-wide"
        style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-default)' }}
      >
        <th className="py-2 px-3 text-left font-medium">{first}</th>
        <th className="py-2 px-3 text-right font-medium">Leads</th>
        <th className="py-2 px-3 text-right font-medium">Ganhos</th>
        <th className="py-2 px-3 text-right font-medium">Conversão</th>
        <th className="py-2 px-3 text-right font-medium">Valor ganho</th>
      </tr>
    </thead>
  );
}

/**
 * Renomear a campanha. É o que substitui a API do Google: o ID continua sendo
 * a chave, e o nome legível é escrito uma vez aqui.
 */
function CampaignLabel({ row }: { row: CampaignRow }) {
  const qc = useQueryClient();
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(row.label);

  const salvar = useMutation({
    mutationFn: async (label: string) => {
      await api.post('/api/attribution/campaign-label', {
        source: row.source,
        campaign_id: row.campaign_id,
        label,
      });
    },
    onSuccess: () => {
      setEditando(false);
      void qc.invalidateQueries({ queryKey: ['attribution-campaigns'] });
    },
  });

  if (editando) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          className="h-7 text-xs"
          maxLength={120}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valor.trim()) salvar.mutate(valor.trim());
            if (e.key === 'Escape') setEditando(false);
          }}
        />
        <button
          type="button"
          onClick={() => valor.trim() && salvar.mutate(valor.trim())}
          disabled={salvar.isPending}
          className="p-1 rounded hover:bg-[var(--bg-surface-3)]"
          aria-label="Salvar nome"
        >
          <Check size={14} style={{ color: '#22c55e' }} />
        </button>
        <button
          type="button"
          onClick={() => {
            setValor(row.label);
            setEditando(false);
          }}
          className="p-1 rounded hover:bg-[var(--bg-surface-3)]"
          aria-label="Cancelar"
        >
          <X size={14} style={{ color: 'var(--text-muted)' }} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 group">
      <span className="truncate" style={{ color: 'var(--text-primary)' }}>
        {row.label}
      </span>
      {!row.has_custom_label && /^\d+$/.test(row.label) && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
          style={{ background: 'var(--bg-surface-3)', color: 'var(--text-muted)' }}
        >
          sem nome
        </span>
      )}
      <button
        type="button"
        onClick={() => setEditando(true)}
        className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--bg-surface-3)]"
        aria-label="Renomear campanha"
      >
        <Pencil size={12} style={{ color: 'var(--text-muted)' }} />
      </button>
    </div>
  );
}

/**
 * Seção "Origem dos leads" do /analytics: canais, campanhas e palavras-chave.
 * Busca os próprios dados para que entrar na página custe uma linha.
 */
export function AttributionSection({ from, to }: { from: string; to: string }) {
  const { data: summary, isLoading: loadingSummary } = useQuery<AttributionSummary>({
    queryKey: ['attribution-summary', from, to],
    queryFn: async () => {
      const res = await api.get('/api/attribution/summary', { params: { from, to } });
      return res.data;
    },
  });

  const { data: campanhas, isLoading: loadingCampanhas } = useQuery<AttributionCampaigns>({
    queryKey: ['attribution-campaigns', from, to],
    queryFn: async () => {
      const res = await api.get('/api/attribution/campaigns', { params: { from, to } });
      return res.data;
    },
  });

  const canais = (summary?.channels ?? []).filter((c) => c.leads > 0);

  return (
    <div className="grid grid-cols-1 gap-4">
      <SectionCard
        title="Origem dos leads"
        icon={Megaphone}
        action={
          summary ? (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {percentFmt(summary.paid.share)} de tráfego pago ·{' '}
              {numberFmt.format(summary.paid.leads)} leads
            </span>
          ) : undefined
        }
      >
        {loadingSummary ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : canais.length === 0 ? (
          <p className="text-sm py-6 text-center" style={{ color: 'var(--text-muted)' }}>
            Nenhum lead no período.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead first="Canal" />
              <tbody>
                {canais.map((c) => {
                  const meta = channelMeta(String(c.channel));
                  return (
                    <tr
                      key={String(c.channel)}
                      style={{ borderBottom: '1px solid var(--border-subtle)' }}
                    >
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ background: meta.color }}
                          />
                          <span style={{ color: 'var(--text-primary)' }}>{meta.label}</span>
                          {c.paid && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{ background: 'var(--primary-subtle)', color: 'var(--primary)' }}
                            >
                              pago
                            </span>
                          )}
                        </div>
                      </td>
                      <MetricCells row={c} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Campanhas" icon={Megaphone}>
          {loadingCampanhas ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (campanhas?.campaigns.length ?? 0) === 0 ? (
            <p className="text-sm py-6 text-center" style={{ color: 'var(--text-muted)' }}>
              Nenhuma campanha identificada. Confira o modelo de acompanhamento na conta de
              anúncios e o snippet no site (Configurações › Rastreamento).
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <TableHead first="Campanha" />
                <tbody>
                  {campanhas?.campaigns.map((c) => (
                    <tr
                      key={`${c.source}:${c.campaign_id}`}
                      style={{ borderBottom: '1px solid var(--border-subtle)' }}
                    >
                      <td className="py-2 px-3 max-w-[240px]">
                        <CampaignLabel row={c} />
                      </td>
                      <MetricCells row={c} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Palavras-chave" icon={Search}>
          {loadingCampanhas ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (campanhas?.keywords.length ?? 0) === 0 ? (
            <p className="text-sm py-6 text-center" style={{ color: 'var(--text-muted)' }}>
              Nenhuma palavra-chave no período.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <TableHead first="Termo" />
                <tbody>
                  {campanhas?.keywords.map((k) => (
                    <tr key={k.keyword} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td
                        className="py-2 px-3 max-w-[240px] truncate"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {k.keyword}
                      </td>
                      <MetricCells row={k} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
