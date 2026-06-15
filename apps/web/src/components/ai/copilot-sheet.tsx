'use client';

import { useRef, useState } from 'react';
import { Sparkles, Send } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Copilot do atendente: chat lateral com a IA, ancorado no lead em foco.
 * A IA recebe o contexto do lead no backend; aqui só trafega o histórico do
 * chat com o copiloto. Não envia nada ao cliente.
 */
export function CopilotSheet({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function send() {
    const content = input.trim();
    if (!content || loading) return;
    const next = [...messages, { role: 'user' as const, content }];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const { data } = await api.post<{ reply: string }>('/api/ai/copilot', {
        lead_id: leadId,
        messages: next,
      });
      setMessages([...next, { role: 'assistant', content: data.reply }]);
      setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 50);
    } catch {
      toast.error('Falha no copiloto (verifique a config de IA)');
      setMessages(messages); // reverte a pergunta otimista
    } finally {
      setLoading(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Copiloto IA" title="Copiloto IA" className="h-9 w-9">
          <Sparkles size={18} className="text-[var(--primary)]" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-4 py-3" style={{ borderColor: 'var(--border-default)' }}>
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Sparkles size={16} className="text-[var(--primary)]" /> Copiloto IA
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="flex-1 px-4 py-3">
          <div ref={scrollRef} className="space-y-3">
            {messages.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Pergunte sobre este lead — resumo da conversa, próximo passo, objeções, etc.
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  m.role === 'user' ? 'ml-auto bg-[var(--primary)] text-white' : 'bg-[var(--bg-surface-3)] text-[var(--text-primary)]'
                }`}
              >
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
            ))}
            {loading && <p className="text-xs text-muted-foreground">Pensando…</p>}
          </div>
        </ScrollArea>

        <div className="flex items-center gap-2 border-t p-3" style={{ borderColor: 'var(--border-default)' }}>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder="Pergunte ao copiloto…"
            disabled={loading}
          />
          <Button size="icon" onClick={() => void send()} disabled={loading || !input.trim()} className="h-9 w-9 shrink-0">
            <Send size={16} />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
