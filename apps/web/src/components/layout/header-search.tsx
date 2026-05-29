'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search, Loader2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';

interface LeadResult {
  id: string;
  nome: string;
  telefone: string;
  foto_url?: string | null;
}

function initials(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? '').join('');
}

export function HeaderSearch() {
  const router = useRouter();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 300);
    return () => clearTimeout(t);
  }, [term]);

  // Fecha ao clicar fora.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const enabled = debounced.length >= 2;
  const { data: results = [], isFetching } = useQuery<LeadResult[]>({
    queryKey: ['header-search', debounced],
    queryFn: async () => {
      const { data } = await api.get('/api/leads', { params: { search: debounced, limit: 8 } });
      return Array.isArray(data) ? data : (data?.data ?? []);
    },
    enabled,
    staleTime: 10_000,
  });

  const go = (id: string) => {
    setOpen(false);
    setTerm('');
    setDebounced('');
    router.push(`/chat/${id}`);
  };

  return (
    <div ref={boxRef} className="relative hidden md:block">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        placeholder="Buscar contato..."
        aria-label="Buscar contato"
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onFocus={() => term.length >= 2 && setOpen(true)}
        autoComplete="off"
        className="h-9 w-64 pl-9 pr-8"
      />
      {isFetching && <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
      {!isFetching && term && (
        <button
          type="button"
          aria-label="Limpar"
          onClick={() => { setTerm(''); setDebounced(''); setOpen(false); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}

      {open && enabled && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-lg border border-border bg-popover shadow-lg overflow-hidden">
          {isFetching && results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-muted-foreground">Buscando...</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-muted-foreground">Nenhum contato encontrado.</div>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => go(r.id)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent transition-colors"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold" style={{ background: 'var(--primary-subtle)', color: 'var(--primary)' }}>
                      {initials(r.nome) || '?'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.nome}</span>
                      <span className="block truncate text-xs text-muted-foreground">{r.telefone}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
