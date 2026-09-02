import {
  agruparPorDia,
  categoriaDoItem,
  filtrarPorCategoria,
  rotuloMidia,
  rotuloSessao,
  rotuloTarefa,
  type SessaoItem,
  type TarefaItem,
  type TimelineItem,
} from './lead-timeline-view';

const sessao = (over: Partial<SessaoItem> = {}): SessaoItem => ({
  tipo: 'sessao', id: 's1', quando: '2026-09-01T17:40:00.000Z', inicio: '2026-09-01T17:02:00.000Z',
  fim: '2026-09-01T17:40:00.000Z', total: 14, recebidas: 8, enviadas: 6, ultima_direcao: 'OUTGOING',
  preview: 'fechado', instancia: 'inst-A', primeira_mensagem_id: 'm1', truncada: false, ...over,
});
const nota: TimelineItem = { tipo: 'nota', id: 'n1', quando: '2026-09-01T12:00:00.000Z', conteudo: 'x', autor: null, mencoes: [] };
const tarefa: TarefaItem = {
  tipo: 'tarefa', id: 't1', quando: '2026-09-02T09:00:00.000Z', evento: 'concluida', titulo: 'Ligar',
  tipo_tarefa: 'LIGACAO', status: 'CONCLUIDA', scheduled_at: '2026-09-01T09:00:00.000Z', completed_at: '2026-09-02T09:00:00.000Z', responsavel: null,
};
const atividade: TimelineItem = { tipo: 'atividade', id: 'a1', quando: '2026-09-01T11:00:00.000Z', subtipo: 'stage_change', descricao: '', dados_antes: null, dados_depois: null, autor: null };
const lembrete: TimelineItem = { tipo: 'lembrete', id: 'l1', quando: '2026-09-01T10:00:00.000Z', motivo: 'retorno', avisar_em: '2026-09-03T09:00:00.000Z', status: 'pendente', origem: 'ia' };

describe('categoriaDoItem / filtrarPorCategoria', () => {
  it('mapeia os 5 tipos em 4 categorias', () => {
    expect(categoriaDoItem(sessao())).toBe('conversas');
    expect(categoriaDoItem(nota)).toBe('notas');
    expect(categoriaDoItem(tarefa)).toBe('tarefas');
    expect(categoriaDoItem(lembrete)).toBe('tarefas');
    expect(categoriaDoItem(atividade)).toBe('eventos');
  });
  it('tudo devolve a lista intacta; categoria filtra', () => {
    const todos = [sessao(), nota, tarefa, atividade, lembrete];
    expect(filtrarPorCategoria(todos, 'tudo')).toBe(todos);
    expect(filtrarPorCategoria(todos, 'tarefas').map((i) => i.id)).toEqual(['t1', 'l1']);
  });
});

describe('rotulos', () => {
  it('sessao com varias mensagens mostra intervalo', () => {
    // Horas dependem do fuso da maquina: so o formato e fixo.
    expect(rotuloSessao(sessao())).toMatch(/^14 mensagens · \d{2}:\d{2}–\d{2}:\d{2}$/);
  });
  it('sessao de 1 mostra so a hora', () => {
    expect(rotuloSessao(sessao({ total: 1, inicio: sessao().fim }))).toMatch(/^1 mensagem · \d{2}:\d{2}$/);
  });
  it('sessao truncada avisa', () => {
    expect(rotuloSessao(sessao({ truncada: true }))).toMatch(/\(cortada em 500\)$/);
  });
  it('tarefa por evento', () => {
    expect(rotuloTarefa(tarefa)).toBe('Tarefa concluída: Ligar');
    expect(rotuloTarefa({ ...tarefa, evento: 'criada' })).toBe('Tarefa criada: Ligar');
  });
  it('midia por tipo', () => {
    expect(rotuloMidia('IMAGE', null)).toBe('Imagem');
    expect(rotuloMidia('DOCUMENT', 'orcamento.pdf')).toBe('orcamento.pdf');
    expect(rotuloMidia('DOCUMENT', null)).toBe('Documento');
    expect(rotuloMidia('AUDIO', null)).toBe('Áudio');
  });
});

describe('agruparPorDia', () => {
  it('mantem a ordem e agrupa por dia local', () => {
    const grupos = agruparPorDia([tarefa, nota, atividade]);
    expect(grupos).toHaveLength(2);
    expect(grupos[0].items.map((i) => i.id)).toEqual(['t1']);
    expect(grupos[1].items.map((i) => i.id)).toEqual(['n1', 'a1']);
    expect(grupos[1].dia).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
