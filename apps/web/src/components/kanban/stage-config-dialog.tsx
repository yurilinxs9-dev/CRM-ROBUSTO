'use client';

import { useEffect, useState } from 'react';
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
import { cn } from '@/lib/utils';

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

export interface StageConfig {
  id: string;
  nome: string;
  cor: string;
  is_won: boolean;
  is_lost: boolean;
  max_dias: number | null;
  auto_action: any;
  sla_config?: any;
  idle_alert_config?: any;
  on_entry_config?: any;
  cadence_config?: any;
}

interface StageConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stage: StageConfig | null;
  isLoading?: boolean;
  onSubmit: (data: any) => void;
}

export function StageConfigDialog({
  open,
  onOpenChange,
  stage,
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

  // Idle
  const [idleEnabled, setIdleEnabled] = useState(false);
  const [idleValue, setIdleValue] = useState('2');
  const [idleUnit, setIdleUnit] = useState('HOURS');

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

    // Idle
    const idle = stage.idle_alert_config;
    setIdleEnabled(!!idle?.enabled);
    setIdleValue(String(idle?.duration ?? '2'));
    setIdleUnit(idle?.unit ?? 'HOURS');

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
      },
      idle_alert_config: {
        enabled: idleEnabled,
        duration: parseInt(idleValue, 10),
        unit: idleUnit,
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

  const Section = ({ id, title, icon: Icon, children }: { id: string, title: string, icon: any, children: React.ReactNode }) => {
    const isOpen = openSection === id;
    return (
      <div className="border rounded-lg overflow-hidden mb-3">
        <button
          type="button"
          onClick={() => setOpenSection(isOpen ? null : id)}
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 text-left transition-colors",
            isOpen ? "bg-muted/50" : "hover:bg-muted/30"
          )}
        >
          <div className="flex items-center gap-3">
            <div className={cn("p-1.5 rounded-md", isOpen ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
              <Icon size={16} />
            </div>
            <span className="font-medium text-sm">{title}</span>
          </div>
          {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {isOpen && <div className="p-4 bg-background space-y-4 border-t">{children}</div>}
      </div>
    );
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
          <Section id="sla" title="SLA e Alertas de Ociosidade" icon={Clock}>
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

              {/* Idle Alert */}
              <div className="flex items-start justify-between gap-4 pt-4 border-t">
                <div className="space-y-1">
                  <Label className="text-sm font-semibold">Alerta de Ociosidade</Label>
                  <p className="text-xs text-muted-foreground">Avisar se o cliente ficar muito tempo sem resposta.</p>
                </div>
                <Switch checked={idleEnabled} onCheckedChange={setIdleEnabled} />
              </div>

              {idleEnabled && (
                <div className="grid grid-cols-2 gap-3 pl-4 border-l-2 border-orange-400/40 py-1">
                  <div>
                    <Label className="text-[10px] uppercase mb-1 block">Sem resposta há</Label>
                    <Input type="number" value={idleValue} onChange={e => setIdleValue(e.target.value)} />
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
          <Section id="entry" title="Ações ao Entrar na Etapa" icon={Zap}>
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
          <Section id="cadence" title="Régua de Cadência e Follow-up" icon={Repeat}>
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
                        className="text-xs min-h-[60px] mb-3 bg-background"
                      />

                      {step.mode === 'AUTO' && (
                        <div className="flex items-center gap-2 p-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400">
                          <AlertTriangle size={14} />
                          <div className="flex-1 text-[10px] leading-tight">
                            <strong>Trava Anti-Robô:</strong> Só dispara se o cliente estiver sem responder há mais de 10 min.
                          </div>
                        </div>
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
