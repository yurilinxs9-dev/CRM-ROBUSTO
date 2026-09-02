import {
  agruparSessoes,
  mesclarTimeline,
  mesmaSessao,
  previewDaMensagem,
  SESSAO_GAP_MS,
  SESSAO_MAX_MENSAGENS,
  type MensagemParaSessao,
  type TimelineItem,
} from './lead-timeline';

const t0 = Date.parse('2026-09-01T12:00:00.000Z');
const min = (n: number) => new Date(t0 + n * 60_000);

function msg(over: Partial<MensagemParaSessao> & { at: Date }): MensagemParaSessao {
  return {
    id: `m-${over.at.getTime()}`,
    created_at: over.at,
    direction: over.direction ?? 'INCOMING',
    type: over.type ?? 'TEXT',
    content: over.content ?? 'oi',
    instance_name: over.instance_name ?? 'inst-A',
  };
}

describe('previewDaMensagem', () => {
  it('texto vem cortado em 140 chars', () => {
    expect(previewDaMensagem({ type: 'TEXT', content: 'a'.repeat(200) })).toHaveLength(140);
  });
  it('midia vira rotulo entre colchetes', () => {
    expect(previewDaMensagem({ type: 'IMAGE', content: null })).toBe('[Imagem]');
    expect(previewDaMensagem({ type: 'AUDIO', content: null })).toBe('[Áudio]');
    expect(previewDaMensagem({ type: 'DOCUMENT', content: 'x.pdf' })).toBe('[Documento] x.pdf');
  });
});

describe('mesmaSessao', () => {
  it('29:59 e a mesma sessao, 30:01 nao', () => {
    const atual = min(60);
    expect(mesmaSessao(atual, new Date(atual.getTime() - SESSAO_GAP_MS + 1000))).toBe(true);
    expect(mesmaSessao(atual, new Date(atual.getTime() - SESSAO_GAP_MS - 1000))).toBe(false);
  });
});

describe('agruparSessoes', () => {
  it('uma mensagem sozinha vira uma sessao de 1', () => {
    const [s] = agruparSessoes([msg({ at: min(0) })]);
    expect(s.total).toBe(1);
    expect(s.inicio).toBe(s.fim);
    expect(s.primeira_mensagem_id).toBe('m-' + min(0).getTime());
  });

  it('separa por gap de 30 min e conta direcoes', () => {
    // entrada desc: 70, 65 (sessao B) | 20, 10, 0 (sessao A)
    const entrada = [
      msg({ at: min(70), direction: 'OUTGOING', content: 'fechado, mando o pix' }),
      msg({ at: min(65) }),
      msg({ at: min(20) }),
      msg({ at: min(10), direction: 'OUTGOING' }),
      msg({ at: min(0) }),
    ];
    const sessoes = agruparSessoes(entrada);
    expect(sessoes).toHaveLength(2);
    expect(sessoes[0].fim).toBe(min(70).toISOString());
    expect(sessoes[0].quando).toBe(min(70).toISOString());
    expect(sessoes[0].total).toBe(2);
    expect(sessoes[0].preview).toBe('fechado, mando o pix');
    expect(sessoes[0].ultima_direcao).toBe('OUTGOING');
    expect(sessoes[1].inicio).toBe(min(0).toISOString());
    expect(sessoes[1].fim).toBe(min(20).toISOString());
    expect(sessoes[1].recebidas).toBe(2);
    expect(sessoes[1].enviadas).toBe(1);
    expect(sessoes[1].primeira_mensagem_id).toBe('m-' + min(0).getTime());
  });

  it('fecha a forca em SESSAO_MAX_MENSAGENS e marca truncada', () => {
    const entrada = Array.from({ length: SESSAO_MAX_MENSAGENS + 5 }, (_, i) =>
      msg({ at: new Date(t0 + i * 1000) }),
    ).reverse();
    const sessoes = agruparSessoes(entrada);
    expect(sessoes[0].total).toBe(SESSAO_MAX_MENSAGENS);
    expect(sessoes[0].truncada).toBe(true);
    expect(sessoes[1].total).toBe(5);
  });
});

describe('mesclarTimeline', () => {
  const item = (tipo: TimelineItem['tipo'], quando: string): TimelineItem =>
    ({ tipo, id: `${tipo}-${quando}`, quando } as unknown as TimelineItem);

  it('ordena desc por quando entre fontes e corta em limit', () => {
    const r = mesclarTimeline(
      [
        [item('sessao', '2026-09-01T10:00:00.000Z')],
        [item('nota', '2026-09-01T11:00:00.000Z'), item('nota', '2026-09-01T09:00:00.000Z')],
      ],
      2,
      false,
    );
    expect(r.items.map((i) => i.quando)).toEqual([
      '2026-09-01T11:00:00.000Z',
      '2026-09-01T10:00:00.000Z',
    ]);
    expect(r.nextCursor).toBe('2026-09-01T10:00:00.000Z');
  });

  it('sem sobra e sem fonte com mais, nextCursor e undefined', () => {
    const r = mesclarTimeline([[item('nota', '2026-09-01T11:00:00.000Z')]], 10, false);
    expect(r.nextCursor).toBeUndefined();
  });

  it('alguma fonte com mais forca nextCursor mesmo sem sobra local', () => {
    const r = mesclarTimeline([[item('nota', '2026-09-01T11:00:00.000Z')]], 10, true);
    expect(r.nextCursor).toBe('2026-09-01T11:00:00.000Z');
  });
});
