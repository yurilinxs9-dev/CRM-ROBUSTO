'use client';

import { useEffect, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { 
  Clock, 
  Zap, 
  Repeat, 
  Plus, 
  Trash2, 
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  UserPlus,
  ClipboardList
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

interface TenantUser {
  id: string;
  nome: string;
  email: string;
  role: string;
}

const TIME_UNITS = [
  { label: 'Minutos', value: 'MINUTES' },
  { label: 'Horas', value: 'HOURS' },
  { label: 'Dias', value: 'DAYS' },
];

export interface CadenceStep {
  id: string;
  duration: number;
  unit: 'MINUTES' | 'HOURS' | 'DAYS';
  mode: 'MANUAL' | 'AUTO';
  template: string;
  safety_lock?: {
    enabled: boolean;
    duration: number;
    unit: 'MINUTES' | 'HOURS' | 'DAYS';
  };
}

export interface StageAutoActionForm {
  on_enter?: {
    create_task?: { titulo: string; tipo: any; offset_min: number };
    send_message?: { content: string };
    assign_user?: { user_id: string };
  };
}

export interface StageConfig {
  id: string;
  nome: string;
  cor: string;
  is_won: boolean;
  is_lost: boolean;
  max_dias: number | null;
  auto_action: StageAutoActionForm | null;
  sla_config?: any;
  idle_alert_config?: any;
  response_alert_config?: any;
  on_entry_config?: any;
  cadence_config?: any;
}

interface StageConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stage: StageConfig | null;
  allStages?: { id: string; nome: string }[];
  isLoading?: boolean;
  onSubmit: (data: any) => void;
}

function FireCadenceButton({ stageId, stepIndex, template }: { stageId: string; stepIndex: number; template: string }) {
  const [sendState, setSendState] = useState<'idle' | 'loading' | 'sending' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<{ scheduled: number; totalEligible: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [eligible, setEligible] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const [batchSize, setBatchSize] = useState<number>(30);
  const [delayMin, setDelayMin] = useState<number>(15);
  const [delayMax, setDelayMax] = useState<number>(45);
  const [remaining, setRemaining] = useState<number | null>(null);

  const loadCount = useCallback(async () => {
    setLoadingCount(true);
    try {
      const res = await api.get(`/api/stages/${stageId}/cadence-eligible?stepIndex=${stepIndex}`);
      setEligible(res.data.count);
      setBatchSize((prev) => Math.min(prev, res.data.count || prev));
    } catch {
      setEligible(null);
    } finally {
      setLoadingCount(false);
    }
  }, [stageId, stepIndex]);

  const openConfirm = useCallback(async () => {
    await loadCount();
    setConfirming(true);
  }, [loadCount]);

  // Polling: enquanto status === 'sending', re-consulta count para mostrar progresso
  useEffect(() => {
    if (sendState !== 'sending' || !result) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.get(`/api/stages/${stageId}/cadence-eligible?stepIndex=${stepIndex}`);
        if (cancelled) return;
        const left = res.data.count;
        setRemaining(left);
        const sent = result.scheduled - Math.min(left, result.scheduled);
        if (sent >= result.scheduled || left <= 0) {
          setSendState('done');
        }
      } catch {
        // mantém polling
      }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [sendState, result, stageId, stepIndex]);

  const fire = useCallback(async () => {
    setConfirming(false);
    setSendState('loading');
    try {
      const res = await api.post(`/api/stages/${stageId}/fire-cadence-step`, {
        stepIndex,
        batchSize,
        delayMinSec: delayMin,
        delayMaxSec: delayMax,
      });
      setResult(res.data);
      setRemaining(res.data.scheduled);
      setSendState(res.data.scheduled > 0 ? 'sending' : 'done');
    } catch {
      setSendState('error');
    }
  }, [stageId, stepIndex, batchSize, delayMin, delayMax]);

  if (sendState === 'sending' && result) {
    const sent = Math.max(0, result.scheduled - (remaining ?? result.scheduled));
    const pct = Math.round((sent / Math.max(1, result.scheduled)) * 100);
    return (
      <div className="mt-2 mb-3 space-y-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-blue-600 dark:text-blue-400 font-medium">
            Enviando {sent}/{result.scheduled}
          </span>
          <span className="text-muted-foreground tabular-nums">{pct}%</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }

  if (sendState === 'done' && result) {
    return (
      <div className="mt-2 mb-3 flex items-center justify-between gap-2">
        <p className="text-[11px] text-green-600 dark:text-green-400 font-medium">
          ✓ {result.scheduled} mensagens enviadas
        </p>
        <button
          type="button"
          onClick={() => { setSendState('idle'); setResult(null); setRemaining(null); }}
          className="text-[10px] text-muted-foreground hover:text-foreground underline"
        >
          Disparar novamente
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="mt-2 mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={openConfirm}
          disabled={sendState === 'loading'}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 transition-colors disabled:opacity-50"
        >
          <MessageSquare size={12} />
          {sendState === 'loading' ? 'Agendando...' : sendState === 'error' ? 'Erro — tentar de novo' : 'Enviar mensagem'}
        </button>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="text-sm">Configurar disparo</DialogTitle>
            <DialogDescription className="text-xs">
              {loadingCount ? (
                'Verificando leads elegíveis...'
              ) : eligible !== null ? (
                <><span className="font-bold text-foreground">{eligible}</span> lead{eligible !== 1 ? 's' : ''} elegível{eligible !== 1 ? 'is' : ''} (Trava Anti-Robô já aplicada).</>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <p className="text-[11px] text-muted-foreground italic line-clamp-3 p-2 rounded bg-muted/40">"{template}"</p>

            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-medium text-muted-foreground">Qtd. envio</span>
                <Input
                  type="number"
                  min={1}
                  max={eligible ?? undefined}
                  value={batchSize}
                  onChange={(e) => setBatchSize(Math.max(1, parseInt(e.target.value, 10) || 0))}
                  className="h-8 text-xs"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-medium text-muted-foreground">Delay min (s)</span>
                <Input
                  type="number"
                  min={0}
                  value={delayMin}
                  onChange={(e) => setDelayMin(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  className="h-8 text-xs"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-medium text-muted-foreground">Delay max (s)</span>
                <Input
                  type="number"
                  min={0}
                  value={delayMax}
                  onChange={(e) => setDelayMax(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  className="h-8 text-xs"
                />
              </label>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Tempo estimado: ~{Math.round((batchSize * (delayMin + delayMax)) / 2 / 60)} min
            </p>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="px-3 py-1.5 rounded text-xs font-medium border border-border hover:bg-muted transition-colors"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={fire}
              disabled={eligible === 0 || batchSize < 1 || delayMax < delayMin}
              className="px-3 py-1.5 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
            >
              {eligible === 0 ? 'Nenhum lead elegível' : `Disparar ${batchSize}`}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Section hoisted fora do StageConfigDialog — definir dentro causava perda de foco
// nos inputs (componente nova a cada render → React desmonta subárvore).
function Section({
  id,
  title,
  icon: Icon,
  children,
  openSection,
  setOpenSection,
}: {
  id: string;
  title: string;
  icon: any;
  children: React.ReactNode;
  openSection: string | null;
  setOpenSection: (v: string | null) => void;
}) {
  const isOpen = openSection === id;
  return (
    <div className="border rounded-lg overflow-hidden mb-3">
      <button
        type="button"
        onClick={() => setOpenSection(isOpen ? null : id)}
        className={cn(
          'w-full flex items-center justify-between px-4 py-3 text-left transition-colors',
          isOpen ? 'bg-muted/50' : 'hover:bg-muted/30',
        )}
      >
        <div className="flex items-center gap-3">
          <div className={cn('p-1.5 rounded-md', isOpen ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
            <Icon size={16} />
          </div>
          <span className="font-medium text-sm">{title}</span>
        </div>
        {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {isOpen && <div className="p-4 bg-background space-y-4 border-t">{children}</div>}
    </div>
  );
}

export function StageConfigDialog({
  open,
  onOpenChange,
  stage,
  allStages = [],
  isLoading,
  onSubmit,
}: StageConfigDialogProps) {
  const { data: tenantUsers = [] } = useQuery<TenantUser[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await api.get('/api/users/list');
      return res.data;
    },
  });

  // --- States ---
  const [type, setType] = useState<'ACTIVE' | 'WON' | 'LOST'>('ACTIVE');
  
  // SLA
  const [slaEnabled, setSlaEnabled] = useState(false);
  const [slaValue, setSlaValue] = useState('24');
  const [slaUnit, setSlaUnit] = useState('HOURS');
  const [slaAction, setSlaAction] = useState('ALERT');
  const [slaTargetStageId, setSlaTargetStageId] = useState('');

  // Idle (cliente sem resposta)
  const [idleEnabled, setIdleEnabled] = useState(false);
  const [idleValue, setIdleValue] = useState('2');
  const [idleUnit, setIdleUnit] = useState('HOURS');

  // Response alert (nós sem responder)
  const [respEnabled, setRespEnabled] = useState(false);
  const [respValue, setRespValue] = useState('2');
  const [respUnit, setRespUnit] = useState('HOURS');

  // On Entry
  const [taskOn, setTaskOn] = useState(false);
  const [taskTitulo, setTaskTitulo] = useState('');
  const [taskDueValue, setTaskDueValue] = useState('1');
  const [taskDueUnit, setTaskDueUnit] = useState('HOURS');
  
  const [msgOn, setMsgOn] = useState(false);
  const [msgContent, setMsgContent] = useState('');
  
  const [assignOn, setAssignOn] = useState(false);

  // Cadence
  const [cadenceEnabled, setCadenceEnabled] = useState(false);
  const [steps, setSteps] = useState<CadenceStep[]>([]);

  // Accordion/Disclosure states
  const [openSection, setOpenSection] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !stage) return;
    
    // Initial type
    if (stage.is_won) setType('WON');
    else if (stage.is_lost) setType('LOST');
    else setType('ACTIVE');

    // SLA
    const sla = stage.sla_config;
    setSlaEnabled(!!sla?.enabled);
    setSlaValue(String(sla?.duration ?? '24'));
    setSlaUnit(sla?.unit ?? 'HOURS');
    setSlaAction(sla?.action ?? 'ALERT');
    setSlaTargetStageId(sla?.targetStageId ?? '');

    // Idle (cliente sem resposta)
    const idle = stage.idle_alert_config;
    setIdleEnabled(!!idle?.enabled);
    setIdleValue(String(idle?.duration ?? '2'));
    setIdleUnit(idle?.unit ?? 'HOURS');

    // Response alert (nós sem responder)
    const resp = stage.response_alert_config;
    setRespEnabled(!!resp?.enabled);
    setRespValue(String(resp?.duration ?? '2'));
    setRespUnit(resp?.unit ?? 'HOURS');

    // On Entry
    const entry = stage.on_entry_config;
    setTaskOn(!!entry?.createTask?.enabled);
    setTaskTitulo(entry?.createTask?.title ?? '');
    setTaskDueValue(String(entry?.createTask?.due_duration ?? '1'));
    setTaskDueUnit(entry?.createTask?.due_unit ?? 'HOURS');
    
    setMsgOn(!!entry?.sendInitialMessage?.enabled);
    setMsgContent(entry?.sendInitialMessage?.text ?? '');
    
    setAssignOn(!!entry?.assignResponsible?.enabled);

    // Cadence
    const cadence = stage.cadence_config;
    setCadenceEnabled(!!cadence?.enabled);
    setSteps(cadence?.steps ?? []);
  }, [open, stage]);

  const addStep = () => {
    setSteps([...steps, {
      id: Math.random().toString(36).substr(2, 9),
      duration: 2,
      unit: 'HOURS',
      mode: 'MANUAL',
      template: '',
      safety_lock: { enabled: true, duration: 10, unit: 'MINUTES' }
    }]);
  };

  const removeStep = (id: string) => {
    setSteps(steps.filter(s => s.id !== id));
  };

  const updateStep = (id: string, patch: Partial<CadenceStep>) => {
    setSteps(steps.map(s => s.id === id ? { ...s, ...patch } : s));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const data = {
      is_won: type === 'WON',
      is_lost: type === 'LOST',
      sla_config: {
        enabled: slaEnabled,
        duration: parseInt(slaValue, 10),
        unit: slaUnit,
        action: slaAction,
        targetStageId: slaAction === 'AUTO_MOVE' ? (slaTargetStageId || null) : null,
      },
      idle_alert_config: {
        enabled: idleEnabled,
        duration: parseInt(idleValue, 10),
        unit: idleUnit,
      },
      response_alert_config: {
        enabled: respEnabled,
        duration: parseInt(respValue, 10),
        unit: respUnit,
      },
      on_entry_config: {
        createTask: {
          enabled: taskOn,
          title: taskTitulo,
          due_duration: parseInt(taskDueValue, 10),
          due_unit: taskDueUnit,
        },
        sendInitialMessage: {
          enabled: msgOn,
          text: msgContent,
        },
        assignResponsible: {
          enabled: assignOn,
        }
      },
      cadence_config: {
        enabled: cadenceEnabled,
        steps: steps
      }
    };

    onSubmit(data);
  };


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Configuração Avançada da Etapa</DialogTitle>
          <DialogDescription>
            Defina as regras de automação, SLAs e réguas de cadência para a etapa <span className="font-semibold text-foreground">{stage?.nome}</span>.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-2">
          {/* Tipificação */}
          <div className="mb-6">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-3 block">Tipificação da Etapa</Label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'ACTIVE', label: 'Funil Ativo', color: 'bg-blue-500' },
                { id: 'WON', label: 'Ganho', color: 'bg-green-500' },
                { id: 'LOST', label: 'Perda', color: 'bg-red-500' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setType(t.id as any)}
                  className={cn(
                    "flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all",
                    type === t.id 
                      ? "border-primary bg-primary/5 ring-2 ring-primary/20" 
                      : "border-transparent bg-muted/30 hover:bg-muted/50"
                  )}
                >
                  <div className={cn("h-2 w-8 rounded-full", t.color)} />
                  <span className="text-xs font-semibold">{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Seção 1: SLA e Ociosidade */}
          <Section id="sla" title="SLA e Alertas" icon={Clock} openSection={openSection} setOpenSection={setOpenSection}>
            <div className="space-y-6">
              {/* SLA */}
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label className="text-sm font-semibold">SLA (Tempo Máximo na Etapa)</Label>
                  <p className="text-xs text-muted-foreground">Tempo limite para o lead permanecer nesta coluna.</p>
                </div>
                <Switch checked={slaEnabled} onCheckedChange={setSlaEnabled} />
              </div>
              
              {slaEnabled && (
                <div className="grid grid-cols-12 gap-3 pl-4 border-l-2 border-primary/20 py-1">
                  <div className="col-span-4">
                    <Label className="text-[10px] uppercase mb-1 block">Duração</Label>
                    <Input type="number" value={slaValue} onChange={e => setSlaValue(e.target.value)} />
                  </div>
                  <div className="col-span-4">
                    <Label className="text-[10px] uppercase mb-1 block">Unidade</Label>
                    <Select value={slaUnit} onValueChange={setSlaUnit}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TIME_UNITS.map(u => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-4">
                    <Label className="text-[10px] uppercase mb-1 block">Ação</Label>
                    <Select value={slaAction} onValueChange={setSlaAction}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALERT">Alertar Visualmente</SelectItem>
                        <SelectItem value="AUTO_MOVE">Auto-Mover</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {slaEnabled && slaAction === 'AUTO_MOVE' && (
                <div className="pl-4 border-l-2 border-primary/20 py-1 space-y-1">
                  <Label className="text-[10px] uppercase">Mover para a coluna</Label>
                  <Select value={slaTargetStageId} onValueChange={setSlaTargetStageId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione a etapa destino..." />
                    </SelectTrigger>
                    <SelectContent>
                      {allStages.map((s) => (
                        <SelectItem key={s.id} value={s.id}>{s.nome}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!slaTargetStageId && (
                    <p className="text-[10px] text-destructive">Selecione uma etapa destino para o Auto-Mover.</p>
                  )}
                </div>
              )}

              {/* Alerta 1: NÓS sem responder */}
              <div className="flex items-start justify-between gap-4 pt-4 border-t">
                <div className="space-y-1">
                  <Label className="text-sm font-semibold">🟠 Tempo Sem Resposta</Label>
                  <p className="text-xs text-muted-foreground">Badge laranja quando NÓS ficamos sem responder o cliente além do limite.</p>
                </div>
                <Switch checked={respEnabled} onCheckedChange={setRespEnabled} />
              </div>

              {respEnabled && (
                <div className="grid grid-cols-2 gap-3 pl-4 border-l-2 border-orange-400/40 py-1">
                  <div>
                    <Label className="text-[10px] uppercase mb-1 block">Limite de resposta</Label>
                    <Input type="number" min="1" value={respValue} onChange={e => setRespValue(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-[10px] uppercase mb-1 block">Unidade</Label>
                    <Select value={respUnit} onValueChange={setRespUnit}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TIME_UNITS.map(u => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {/* Alerta 2: CLIENTE sem retorno */}
              <div className="flex items-start justify-between gap-4 pt-4 border-t">
                <div className="space-y-1">
                  <Label className="text-sm font-semibold">🟣 Alerta de Cliente Sem Retorno</Label>
                  <p className="text-xs text-muted-foreground">Badge roxo quando o cliente não retorna após nossa última mensagem.</p>
                </div>
                <Switch checked={idleEnabled} onCheckedChange={setIdleEnabled} />
              </div>

              {idleEnabled && (
                <div className="grid grid-cols-2 gap-3 pl-4 border-l-2 border-purple-400/40 py-1">
                  <div>
                    <Label className="text-[10px] uppercase mb-1 block">Limite de retorno</Label>
                    <Input type="number" min="1" value={idleValue} onChange={e => setIdleValue(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-[10px] uppercase mb-1 block">Unidade</Label>
                    <Select value={idleUnit} onValueChange={setIdleUnit}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TIME_UNITS.map(u => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>
          </Section>

          {/* Seção 2: Ações Automáticas */}
          <Section id="entry" title="Ações ao Entrar na Etapa" icon={Zap} openSection={openSection} setOpenSection={setOpenSection}>
            <div className="space-y-6">
              {/* Criar Tarefa */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ClipboardList size={16} className="text-muted-foreground" />
                    <Label className="text-sm font-semibold">Criar Tarefa Automática</Label>
                  </div>
                  <Switch checked={taskOn} onCheckedChange={setTaskOn} />
                </div>
                {taskOn && (
                  <div className="space-y-3 pl-6 border-l-2 border-muted py-1">
                    <Input placeholder="Ex: Levantar necessidades" value={taskTitulo} onChange={e => setTaskTitulo(e.target.value)} />
                    <div className="grid grid-cols-2 gap-2">
                      <Input type="number" placeholder="Prazo" value={taskDueValue} onChange={e => setTaskDueValue(e.target.value)} />
                      <Select value={taskDueUnit} onValueChange={setTaskDueUnit}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {TIME_UNITS.map(u => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
              </div>

              {/* Mensagem Inicial */}
              <div className="space-y-4 pt-4 border-t">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MessageSquare size={16} className="text-muted-foreground" />
                    <Label className="text-sm font-semibold">Enviar Mensagem de Boas-vindas</Label>
                  </div>
                  <Switch checked={msgOn} onCheckedChange={setMsgOn} />
                </div>
                {msgOn && (
                  <div className="pl-6 border-l-2 border-muted">
                    <Textarea 
                      placeholder="Olá! Recebemos seu contato..." 
                      value={msgContent}
                      onChange={e => setMsgContent(e.target.value)}
                      className="text-xs min-h-[80px]"
                    />
                  </div>
                )}
              </div>

              {/* Atribuir Responsável */}
              <div className="flex items-center justify-between pt-4 border-t">
                <div className="flex items-center gap-2">
                  <UserPlus size={16} className="text-muted-foreground" />
                  <Label className="text-sm font-semibold">Atribuir Responsável (Round-Robin)</Label>
                </div>
                <Switch checked={assignOn} onCheckedChange={setAssignOn} />
              </div>
            </div>
          </Section>

          {/* Seção 3: Régua de Cadência */}
          <Section id="cadence" title="Régua de Cadência e Follow-up" icon={Repeat} openSection={openSection} setOpenSection={setOpenSection}>
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-4">
                <p className="text-xs text-muted-foreground italic">Crie uma escada de avisos temporizados para o vendedor ou bot.</p>
                <Switch checked={cadenceEnabled} onCheckedChange={setCadenceEnabled} />
              </div>

              {cadenceEnabled && (
                <div className="space-y-4">
                  {steps.map((step, index) => (
                    <div key={step.id} className="relative p-4 rounded-lg bg-muted/30 border border-dashed border-muted-foreground/30">
                      <button 
                        type="button" 
                        onClick={() => removeStep(step.id)}
                        className="absolute top-2 right-2 text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                      
                      <div className="flex items-center gap-2 mb-3">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground font-bold">
                          {index + 1}
                        </span>
                        <span className="text-xs font-bold uppercase tracking-wider">Aviso de {step.duration} {TIME_UNITS.find(u => u.value === step.unit)?.label.toLowerCase()}</span>
                      </div>

                      <div className="grid grid-cols-2 gap-2 mb-3">
                        <div className="flex gap-1">
                          <Input 
                            type="number" 
                            className="h-8 text-xs" 
                            value={step.duration} 
                            onChange={e => updateStep(step.id, { duration: parseInt(e.target.value, 10) })} 
                          />
                          <Select value={step.unit} onValueChange={(v: any) => updateStep(step.id, { unit: v })}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {TIME_UNITS.map(u => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <Select value={step.mode} onValueChange={(v: any) => updateStep(step.id, { mode: v })}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="MANUAL">Gatilho Manual</SelectItem>
                            <SelectItem value="AUTO">Disparo Automático (Bot)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <Textarea
                        placeholder="Template da mensagem..."
                        value={step.template}
                        onChange={e => updateStep(step.id, { template: e.target.value })}
                        className="text-xs min-h-[60px] bg-background"
                      />

                      <div className="mt-3 p-2 rounded bg-amber-500/10 border border-amber-500/20 space-y-2">
                        <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                          <AlertTriangle size={14} />
                          <span className="text-[10px] font-bold uppercase tracking-wider">Trava Anti-Robô</span>
                          <Switch
                            checked={!!step.safety_lock?.enabled}
                            onCheckedChange={(v) =>
                              updateStep(step.id, {
                                safety_lock: { ...(step.safety_lock ?? { duration: 10, unit: 'MINUTES' }), enabled: v },
                              })
                            }
                          />
                        </div>
                        {step.safety_lock?.enabled && (
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              type="number"
                              min={1}
                              value={step.safety_lock?.duration ?? 10}
                              onChange={(e) =>
                                updateStep(step.id, {
                                  safety_lock: { ...(step.safety_lock ?? { enabled: true, unit: 'MINUTES' }), duration: parseInt(e.target.value, 10) || 1 },
                                })
                              }
                              className="h-7 text-xs"
                            />
                            <Select
                              value={step.safety_lock?.unit ?? 'MINUTES'}
                              onValueChange={(v: any) =>
                                updateStep(step.id, {
                                  safety_lock: { ...(step.safety_lock ?? { enabled: true, duration: 10 }), unit: v },
                                })
                              }
                            >
                              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {TIME_UNITS.map((u) => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        <p className="text-[10px] text-muted-foreground leading-tight">
                          Só dispara se o cliente estiver sem responder há mais de {step.safety_lock?.duration ?? 10} {TIME_UNITS.find(u => u.value === (step.safety_lock?.unit ?? 'MINUTES'))?.label.toLowerCase()}.
                        </p>
                      </div>

                      {step.mode === 'MANUAL' && step.template && stage?.id && (
                        <FireCadenceButton stageId={stage.id} stepIndex={index} template={step.template} />
                      )}
                    </div>
                  ))}

                  <Button 
                    type="button" 
                    variant="outline" 
                    size="sm" 
                    className="w-full border-dashed"
                    onClick={addStep}
                  >
                    <Plus size={14} className="mr-2" />
                    Adicionar Novo Passo
                  </Button>
                </div>
              )}
            </div>
          </Section>
        </form>

        <DialogFooter className="px-6 py-4 bg-muted/20 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={isLoading}>Salvar Configurações</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
