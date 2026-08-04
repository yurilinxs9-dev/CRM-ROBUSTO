/**
 * Previsão de término da fila de follow-up.
 *
 * A fila anda 1 mensagem a cada `throttleSeconds`, para ao bater o limite do
 * dia e para de novo quando a janela de horário fecha. Um cálculo que ignore a
 * janela mente na direção que mais engana: às 17h de sexta, "20 pendentes x
 * 15min" vira "~5h", quando na verdade o resto só sai na segunda.
 */

export interface JanelaDisparo {
  /** Hora local em que a janela abre (0-23). */
  start: number;
  /** Hora local em que fecha — EXCLUSIVA (18 = último envio antes das 18h). */
  end: number;
  /** ISO: 1=segunda ... 7=domingo. */
  days: number[];
}

export interface EstimativaArgs {
  pending: number;
  throttleSeconds: number;
  dailyLimit: number;
  sentToday: number;
  janela: JanelaDisparo;
  agora: Date;
  timeZone?: string;
}

export interface Estimativa {
  /** true quando a fila está parada esperando a janela abrir. */
  paused: boolean;
  label: string;
}

const TZ_PADRAO = 'America/Sao_Paulo';
const ABREV = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
const ISO_POR_WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * Hora e dia da semana no fuso do disparo, derivados do MESMO instante — ler o
 * dia de um lado e a hora de outro pode divergir na virada. Igual à função pura
 * do backend (`broadcast-window.ts`), de propósito.
 */
function partesLocais(d: Date, timeZone: string): { hour: number; minute: number; weekday: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(d);
  const valor = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '';
  return {
    hour: Number(valor('hour')),
    minute: Number(valor('minute')),
    weekday: ISO_POR_WEEKDAY[valor('weekday')] ?? 1,
  };
}

const proximoDia = (iso: number) => (iso === 7 ? 1 : iso + 1);

export function estimateFinish(args: EstimativaArgs): Estimativa | null {
  const { pending, throttleSeconds, dailyLimit, sentToday, janela, agora } = args;
  if (pending <= 0) return null;
  if (janela.days.length === 0) return { paused: true, label: 'sem dias de disparo configurados' };

  const timeZone = args.timeZone ?? TZ_PADRAO;
  const { hour, minute, weekday } = partesLocais(agora, timeZone);
  const throttle = Math.max(1, throttleSeconds);
  const limite = Math.max(1, dailyLimit);
  const duracaoJanela = Math.max(0, janela.end - janela.start) * 3600;
  const capacidadeDia = Math.max(1, Math.min(limite, Math.floor(duracaoJanela / throttle)));

  const hojeAtivo = janela.days.includes(weekday);
  const dentroDaJanela = hojeAtivo && hour >= janela.start && hour < janela.end;

  if (!dentroDaJanela) {
    // Ainda abre hoje? Só se hoje for dia ativo e a hora não tiver passado.
    if (hojeAtivo && hour < janela.start) {
      return { paused: true, label: `pausado até as ${janela.start}h` };
    }
    let dia = proximoDia(weekday);
    for (let i = 0; i < 7 && !janela.days.includes(dia); i++) dia = proximoDia(dia);
    return { paused: true, label: `pausado até ${ABREV[dia - 1]} às ${janela.start}h` };
  }

  const segundosAteFechar = janela.end * 3600 - (hour * 3600 + minute * 60);
  // O primeiro envio sai imediatamente; os seguintes a cada throttle.
  const slotsAteFechar = 1 + Math.floor((segundosAteFechar - 1) / throttle);
  const hoje = Math.max(0, Math.min(pending, limite - sentToday, slotsAteFechar));
  const sobra = pending - hoje;

  if (sobra === 0) {
    const minutos = Math.round(((hoje - 1) * throttle) / 60);
    if (minutos < 60) return { paused: false, label: `~${minutos}min` };
    const h = Math.floor(minutos / 60);
    const m = minutos % 60;
    return { paused: false, label: m ? `~${h}h${String(m).padStart(2, '0')}` : `~${h}h` };
  }

  // Atravessa o dia: dizer O DIA em que acaba, não "~N dias" — a contagem em
  // dias erra sempre que a fila pula um fim de semana.
  let restante = sobra;
  let dia = weekday;
  for (let avancos = 0; avancos < 7; avancos++) {
    dia = proximoDia(dia);
    if (!janela.days.includes(dia)) continue;
    restante -= capacidadeDia;
    if (restante <= 0) return { paused: false, label: `termina ${ABREV[dia - 1]}` };
  }
  return { paused: false, label: 'mais de uma semana' };
}
