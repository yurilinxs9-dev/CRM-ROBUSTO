import {
  agruparSessoes,
  codificarCursor,
  decodificarCursor,
  mesclarTimeline,
  mesmaSessao,
  previewDaMensagem,
  PREVIEW_MAX,
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
  it('corta por code point, sem partir o emoji da posicao 140', () => {
    const p = previewDaMensagem({ type: 'TEXT', content: 'a'.repeat(139) + '😀' + 'b'.repeat(20) });
    expect([...p]).toHaveLength(PREVIEW_MAX);
    expect(p.endsWith('😀')).toBe(true);
  });
});

describe('mesmaSessao', () => {
  it('29:59 e a mesma sessao, 30:01 nao', () => {
    const atual = min(60);
    expect(mesmaSessao(atual, new Date(atual.getTime() - SESSAO_GAP_MS + 1000))).toBe(true);
    expect(mesmaSessao(atual, new Date(atual.getTime() - SESSAO_GAP_MS - 1000))).toBe(false);
  });
  it('o limite exato de 30 min ainda e a mesma sessao', () => {
    const atual = min(60);
    expect(mesmaSessao(atual, new Date(atual.getTime() - SESSAO_GAP_MS))).toBe(true);
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
    expect(sessoes[0].truncada).toBe(false);
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
    expect(sessoes[1].truncada).toBe(false);
  });

  it('corte por gap natural no teto nao marca truncada', () => {
    const recentes = Array.from({ length: SESSAO_MAX_MENSAGENS }, (_, i) =>
      msg({ at: new Date(t0 + i * 1000) }),
    ).reverse();
    const antiga = msg({ at: new Date(t0 - 5 * 60 * 60_000) });
    const sessoes = agruparSessoes([...recentes, antiga]);
    expect(sessoes).toHaveLength(2);
    expect(sessoes[0].total).toBe(SESSAO_MAX_MENSAGENS);
    expect(sessoes[0].truncada).toBe(false);
    expect(sessoes[1].total).toBe(1);
  });
});

describe('cursor composto', () => {
  it('faz round-trip com e sem mensagensAntes', () => {
    const comMensagens = {
      quando: '2026-09-01T11:00:00.000Z',
      id: 'nota-x',
      mensagensAntes: '2026-09-01T08:00:00.000Z',
    };
    expect(decodificarCursor(codificarCursor(comMensagens))).toEqual(comMensagens);
    const sem = { quando: '2026-09-01T11:00:00.000Z', id: 'nota-x' };
    expect(decodificarCursor(codificarCursor(sem))).toEqual(sem);
  });

  it('devolve null para cursor malformado', () => {
    expect(decodificarCursor('abc')).toBeNull();
    expect(decodificarCursor('nao-data|x')).toBeNull();
    expect(decodificarCursor('2026-09-01T11:00:00.000Z|nota-x|nao-data')).toBeNull();
  });
});

describe('mesclarTimeline', () => {
  const item = (
    tipo: TimelineItem['tipo'],
    quando: string,
    id = `${tipo}-${quando}`,
  ): TimelineItem => ({ tipo, id, quando }) as unknown as TimelineItem;

  const sessao = (quando: string, inicio: string, id = `sessao-${quando}`): TimelineItem =>
    ({ tipo: 'sessao', id, quando, inicio }) as unknown as TimelineItem;

  it('ordena desc por quando entre fontes e corta em limit', () => {
    const r = mesclarTimeline(
      [
        [sessao('2026-09-01T10:00:00.000Z', '2026-09-01T09:45:00.000Z')],
        [item('nota', '2026-09-01T11:00:00.000Z'), item('nota', '2026-09-01T09:00:00.000Z')],
      ],
      2,
      false,
    );
    expect(r.items.map((i) => i.quando)).toEqual([
      '2026-09-01T11:00:00.000Z',
      '2026-09-01T10:00:00.000Z',
    ]);
    expect(r.nextCursor).toBe(
      '2026-09-01T10:00:00.000Z|sessao-2026-09-01T10:00:00.000Z|2026-09-01T09:45:00.000Z',
    );
  });

  it('sem sobra e sem fonte com mais, nextCursor e undefined', () => {
    const r = mesclarTimeline([[item('nota', '2026-09-01T11:00:00.000Z')]], 10, false);
    expect(r.nextCursor).toBeUndefined();
  });

  it('alguma fonte com mais forca nextCursor mesmo sem sobra local', () => {
    const r = mesclarTimeline([[item('nota', '2026-09-01T11:00:00.000Z')]], 10, true);
    expect(r.nextCursor).toBe('2026-09-01T11:00:00.000Z|nota-2026-09-01T11:00:00.000Z|');
  });

  it('empate no quando desempata por id desc', () => {
    const q = '2026-09-01T11:00:00.000Z';
    const r = mesclarTimeline(
      [[item('nota', q, 'nota-a')], [item('tarefa', q, 'tarefa-b'), item('nota', q, 'nota-c')]],
      10,
      false,
    );
    expect(r.items.map((i) => i.id)).toEqual(['tarefa-b', 'nota-c', 'nota-a']);
  });

  it('cursor descarta o que ja foi servido, inclusive empates com id maior', () => {
    const q = '2026-09-01T11:00:00.000Z';
    const antigo = '2026-09-01T10:00:00.000Z';
    const r = mesclarTimeline(
      [
        [
          item('nota', q, 'nota-c'),
          item('nota', q, 'nota-b'),
          item('nota', q, 'nota-a'),
          item('nota', antigo, 'nota-z'),
        ],
      ],
      10,
      false,
      { quando: q, id: 'nota-b' },
    );
    expect(r.items.map((i) => i.id)).toEqual(['nota-a', 'nota-z']);
  });

  it('mensagensAntes do nextCursor e o inicio da sessao mais antiga da pagina', () => {
    const r = mesclarTimeline(
      [
        [
          sessao('2026-09-01T11:00:00.000Z', '2026-09-01T10:30:00.000Z'),
          sessao('2026-09-01T09:00:00.000Z', '2026-09-01T08:30:00.000Z'),
        ],
      ],
      2,
      true,
    );
    expect(decodificarCursor(r.nextCursor ?? '')).toEqual({
      quando: '2026-09-01T09:00:00.000Z',
      id: 'sessao-2026-09-01T09:00:00.000Z',
      mensagensAntes: '2026-09-01T08:30:00.000Z',
    });
  });

  it('pagina sem sessao mantem o mensagensAntes do cursor de entrada', () => {
    const r = mesclarTimeline([[item('nota', '2026-09-01T09:00:00.000Z')]], 10, true, {
      quando: '2026-09-01T10:00:00.000Z',
      id: 'nota-z',
      mensagensAntes: '2026-09-01T08:30:00.000Z',
    });
    expect(decodificarCursor(r.nextCursor ?? '')).toEqual({
      quando: '2026-09-01T09:00:00.000Z',
      id: 'nota-2026-09-01T09:00:00.000Z',
      mensagensAntes: '2026-09-01T08:30:00.000Z',
    });
  });
});

/**
 * Clamp da pagina no horizonte de mensagens: quando a fonte de sessoes ainda
 * tem mais, a pagina nao pode passar do ponto ate onde as mensagens foram
 * lidas — senao o `quando` do proximo cursor fica ABAIXO desse ponto e as
 * sessoes remontadas na pagina seguinte caem no filtro do cursor e somem.
 */
describe('mesclarTimeline — clamp no horizonte de mensagens', () => {
  const item = (
    tipo: TimelineItem['tipo'],
    quando: string,
    id = `${tipo}-${quando}`,
  ): TimelineItem => ({ tipo, id, quando }) as unknown as TimelineItem;
  const sessao = (quando: string, inicio: string, id = `sessao-${quando}`): TimelineItem =>
    ({ tipo: 'sessao', id, quando, inicio }) as unknown as TimelineItem;

  const horizonte = '2026-09-01T12:00:00.000Z';
  const fontes = () => [
    [sessao('2026-09-01T12:30:00.000Z', horizonte, 'sessao-m1')],
    [
      item('atividade', '2026-08-01T10:00:00.000Z', 'a3'),
      item('atividade', '2026-08-01T09:00:00.000Z', 'a2'),
      item('atividade', '2026-08-01T08:00:00.000Z', 'a1'),
    ],
  ];

  it('atividade antiga fica para a proxima pagina e o nextCursor para no horizonte', () => {
    const r = mesclarTimeline(fontes(), 3, true, undefined, horizonte);
    expect(r.items.map((i) => i.id)).toEqual(['sessao-m1']);
    expect(decodificarCursor(r.nextCursor ?? '')).toEqual({
      quando: '2026-09-01T12:30:00.000Z',
      id: 'sessao-m1',
      mensagensAntes: horizonte,
    });
  });

  it('sem horizonte a pagina desce livre (comportamento antigo)', () => {
    const r = mesclarTimeline(fontes(), 3, true);
    expect(r.items.map((i) => i.id)).toEqual(['sessao-m1', 'a3', 'a2']);
  });

  it('o item exatamente NO horizonte continua na pagina', () => {
    const r = mesclarTimeline(
      [[item('nota', horizonte, 'n-no-horizonte')], ...fontes()],
      3,
      true,
      undefined,
      horizonte,
    );
    expect(r.items.map((i) => i.id)).toEqual(['sessao-m1', 'n-no-horizonte']);
  });
});
