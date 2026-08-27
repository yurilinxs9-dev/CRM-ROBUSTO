'use client';

import { useMemo, useState } from 'react';
import {
  BarChart3,
  ChevronDown,
  Kanban,
  List,
  Megaphone,
  Radar,
  Search,
  Settings,
  UserSquare2,
  X,
} from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';

import type { LucideIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Conteudo
// ---------------------------------------------------------------------------

/** Uma pergunta do manual: titulo curto + o texto em portugues de gente. */
interface Topico {
  /** Estavel: vira a chave do estado de aberto/fechado e o `id` do bloco. */
  chave: string;
  titulo: string;
  /** Cada item vira um paragrafo. Nada de markdown: texto puro, sem surpresa. */
  paragrafos: string[];
}

interface Area {
  /** Vira a ancora da URL (`/ajuda#radar`). */
  id: string;
  titulo: string;
  icone: LucideIcon;
  /** Uma frase respondendo "para que serve esta tela". */
  resumo: string;
  /** Onde a tela mora no menu — o caminho que o vendedor tem que percorrer. */
  onde: string;
  topicos: Topico[];
}

const AREAS: Area[] = [
  {
    id: 'radar',
    titulo: 'Radar',
    icone: Radar,
    resumo:
      'A tela por onde vale a pena começar o dia: quem está esperando você, o que o cliente pediu para hoje, onde está o dinheiro e quem já comprou — tudo num lugar só.',
    onde: 'Menu lateral → Radar',
    topicos: [
      {
        chave: 'radar-esperando',
        titulo: 'Esperando você',
        paragrafos: [
          'São os clientes que mandaram mensagem e ainda não receberam resposta da equipe. A lista começa por quem espera há mais tempo, então dá para ir de cima para baixo sem pensar em ordem.',
          'A etiqueta do relógio muda de cor quando a espera passa de 3 horas e muda de novo quando passa de um dia. Assim que você responde, o cliente sai da fila sozinho.',
        ],
      },
      {
        chave: 'radar-lembretes',
        titulo: 'Lembretes de hoje',
        paragrafos: [
          'Muita venda combina uma data na própria conversa: "me chama depois do dia 10", "volto a falar na segunda". O CRM percebe isso na conversa, guarda o compromisso e avisa você no dia certo — você não precisa anotar nada.',
          'O card mostra a frase que o cliente disse e quando ele disse, para você ligar já sabendo do que se trata. Ali mesmo você pode Concluir (quando já falou), Adiar em 1, 7 ou 30 dias, ou Descartar quando o assunto morreu.',
          'Se preferir marcar por conta própria, dá para criar um lembrete na mão pela ficha do lead — ele aparece aqui no dia marcado do mesmo jeito.',
        ],
      },
      {
        chave: 'radar-dinheiro',
        titulo: 'Onde está o dinheiro',
        paragrafos: [
          'Pega os leads promissores e agrupa por etapa do funil, somando o valor estimado de cada grupo. É a resposta rápida para "onde está parado o meu dinheiro hoje".',
          'Etapa em que ninguém preencheu valor aparece com um traço em vez de zero. Clique numa etapa para ver só os leads dela e clique de novo para voltar à lista inteira.',
        ],
      },
      {
        chave: 'radar-foco',
        titulo: 'Foco do dia',
        paragrafos: [
          'Uma lista curta — no máximo dez nomes — com quem mais merece a sua atenção hoje.',
          'A escolha olha o conjunto, não um item só: o retorno que você mesmo marcou na agenda, há quanto tempo vocês trocaram mensagem, o valor da negociação, a nota do atendimento e a temperatura do lead.',
          'Um nome daqui pode aparecer também em outra seção. É de propósito: esta é uma vitrine do que rende mais hoje, não mais uma fila de pendências para zerar.',
        ],
      },
      {
        chave: 'radar-filas',
        titulo: 'Chamar hoje, Promissores e Esfriando',
        paragrafos: [
          'Chamar hoje reúne quem tem uma próxima ação marcada cujo horário já passou: você prometeu voltar a falar e a hora chegou. Assim que uma nova conversa acontece e outra ação é marcada, o lead sai daqui.',
          'Promissores são leads quentes que ficaram alguns dias sem troca de mensagem — o interesse existia e o silêncio é recente, então é onde uma cutucada rende mais.',
          'Esfriando são leads ainda abertos que passaram mais de uma semana sem nenhuma interação. Vale reabrir a conversa ou decidir de vez que a negociação acabou.',
        ],
      },
      {
        chave: 'radar-compraram',
        titulo: 'Compraram',
        paragrafos: [
          'Os clientes que já fecharam: quem está numa etapa de ganho ou tem uma compra registrada na ficha, com os mais recentes na frente.',
          'É a seção do pós-venda — agradecer, pedir indicação, oferecer o próximo produto. Ela nasce fechada porque é consulta, não pendência: abra quando quiser trabalhar quem já é cliente.',
        ],
      },
      {
        chave: 'radar-busca',
        titulo: 'Busca e funis',
        paragrafos: [
          'No topo da tela você escolhe o funil e pode procurar alguém por nome ou telefone. A busca recorta todas as seções ao mesmo tempo.',
          'Acento não atrapalha: "joao" acha "João". No telefone, só os números contam, então tanto faz como ele foi salvo.',
        ],
      },
    ],
  },
  {
    id: 'ficha',
    titulo: 'Ficha do lead',
    icone: UserSquare2,
    resumo:
      'A ficha resume o cliente para você — para não precisar rolar meses de conversa antes de chamar. Ela aparece dentro da conversa e também no card aberto do Radar.',
    onde: 'Conversas → abrir um cliente, ou o card expandido no Radar',
    topicos: [
      {
        chave: 'ficha-resumo',
        titulo: 'O resumo da última conversa',
        paragrafos: [
          'Em poucas linhas, a ficha conta onde vocês pararam: o que o cliente quer, o que ficou combinado e qual foi a objeção.',
          'É para bater o olho antes de chamar e já saber por onde continuar, mesmo que a última conversa tenha sido há três semanas ou com outro colega.',
        ],
      },
      {
        chave: 'ficha-memoria',
        titulo: 'Memória do relacionamento',
        paragrafos: [
          'Além da última conversa, a ficha guarda o que se repete ao longo do tempo: preferências, quem decide, o que já foi oferecido, o que o cliente já recusou.',
          'É aquela memória que um vendedor bom tem de cabeça — só que esta não se perde quando o atendimento troca de mão ou quando alguém sai de férias.',
        ],
      },
      {
        chave: 'ficha-proxima-acao',
        titulo: 'Próxima ação e mensagem sugerida',
        paragrafos: [
          'A ficha sugere qual seria o próximo passo e já escreve uma mensagem pronta para ele.',
          'Nada é enviado sozinho. O texto fica ali para você ler, ajustar o que quiser e decidir se manda. Se não gostou, é só ignorar e escrever do seu jeito — a sugestão nunca vira mensagem sem o seu clique.',
        ],
      },
      {
        chave: 'ficha-nota',
        titulo: 'Nota do atendimento',
        paragrafos: [
          'Uma nota de como o atendimento está indo: se as respostas estão demorando, se ficou pergunta do cliente sem resposta, se o tom está bom.',
          'Serve muito mais para enxergar onde dá para melhorar do que para cobrar alguém. É também um dos sinais que pesam no Foco do dia.',
        ],
      },
      {
        chave: 'ficha-compra',
        titulo: 'Última compra',
        paragrafos: [
          'Quando o cliente já comprou, a ficha mostra o que foi e quando foi.',
          'É a deixa do pós-venda: o que oferecer agora, quando faz sentido voltar, se já passou tempo demais desde a última venda.',
        ],
      },
      {
        chave: 'ficha-temperatura',
        titulo: 'Temperatura automática (frio, morno, quente)',
        paragrafos: [
          'A temperatura diz o quanto o cliente está perto de comprar. Ela pode ser mantida por você na mão, como sempre, ou se atualizar sozinha conforme a conversa muda de tom.',
          'Quem liga o automático é o gerente, em Configurações → Geral, na chave "IA ajusta a temperatura dos leads". Ligada, cada mudança fica registrada na linha do tempo do lead: dá para ver quando esquentou e o que aconteceu ali.',
          'Com a chave desligada, a leitura vira apenas uma sugestão na ficha e a temperatura continua sendo sua — nada muda sem você mandar.',
        ],
      },
      {
        chave: 'ficha-sugestao-etapa',
        titulo: '"Parece pronto para… — mover?"',
        paragrafos: [
          'Quando a conversa indica que o cliente já avançou, a ficha mostra um aviso do tipo "Parece pronto para Proposta — mover?".',
          'O CRM nunca move sozinho. Ou você aceita, e o lead muda de etapa com um clique, ou você recusa. Recusando, essa mesma sugestão fica quieta por 7 dias, para não ficar insistindo em algo que você já respondeu.',
        ],
      },
      {
        chave: 'ficha-lembretes',
        titulo: 'Lembretes do lead',
        paragrafos: [
          'A ficha lista os compromissos daquele cliente: tanto os que o CRM pegou na conversa quanto os que você criar na mão, escolhendo a data e escrevendo o motivo.',
          'No dia marcado eles aparecem em "Lembretes de hoje", no Radar. Concluir ou descartar aqui vale lá também — é a mesma lista vista de dois lugares.',
        ],
      },
    ],
  },
  {
    id: 'kanban',
    titulo: 'Kanban',
    icone: Kanban,
    resumo:
      'O funil desenhado em colunas: cada coluna é uma etapa da venda e cada card é um cliente. É a visão de "como está o jogo" num olhar só.',
    onde: 'Menu lateral → Kanban',
    topicos: [
      {
        chave: 'kanban-etapas',
        titulo: 'Colunas e etapas',
        paragrafos: [
          'Cada coluna é uma etapa do seu processo — do primeiro contato ao fechamento. As etapas são suas: nome, cor e ordem você monta no editor de funil, em Configurações → Funil.',
          'Lá também se marca quais etapas contam como venda ganha e quais contam como perdida. É disso que saem os números de conversão no Dashboard.',
        ],
      },
      {
        chave: 'kanban-arrastar',
        titulo: 'Arrastar o card',
        paragrafos: [
          'Mover o cliente de etapa é arrastar o card para a coluna certa. A mudança fica registrada na linha do tempo do lead, com data e autor.',
          'A equipe vê na hora: quem estiver com a tela aberta enxerga o card mudar de lugar sem precisar atualizar a página.',
        ],
      },
      {
        chave: 'kanban-sla',
        titulo: 'SLA e automações de etapa',
        paragrafos: [
          'Cada etapa pode ter regras próprias, configuradas pelo gerente na engrenagem da coluna.',
          'Dá para definir um tempo máximo de permanência na etapa (o SLA) e o que fazer quando ele estoura, um alerta quando você demora a responder, um aviso quando é o cliente que sumiu, uma tarefa criada automaticamente, uma mensagem de boas-vindas ao entrar na etapa e o rodízio que já escolhe o responsável.',
          'A ideia é simples: o funil cobra sozinho o que costuma ser esquecido no corre-corre.',
        ],
      },
      {
        chave: 'kanban-campos',
        titulo: 'Campos obrigatórios',
        paragrafos: [
          'Além dos dados básicos, sua empresa pode criar campos próprios — placa do carro, plano escolhido, origem da indicação, o que fizer sentido.',
          'Um campo pode ser marcado como obrigatório. Quando ele é, o CRM pede o preenchimento na hora de cadastrar o lead, em vez de deixar a ficha andar pelo funil com buraco.',
        ],
      },
      {
        chave: 'kanban-csv',
        titulo: 'Exportar CSV',
        paragrafos: [
          'O botão Exportar CSV, na barra de cima do Kanban, baixa a lista do recorte que está na tela — o funil escolhido, a temperatura e o responsável filtrados.',
          'O arquivo abre direto no Excel ou no Google Planilhas, para relatório, conferência ou uma campanha fora do CRM.',
        ],
      },
    ],
  },
  {
    id: 'leads',
    titulo: 'Leads e views salvas',
    icone: List,
    resumo:
      'A mesma carteira do Kanban vista como tabela: boa para comparar, ordenar e trabalhar muita gente de uma vez.',
    onde: 'Menu lateral → Leads',
    topicos: [
      {
        chave: 'leads-lista',
        titulo: 'A lista de leads',
        paragrafos: [
          'Leads e Kanban mostram os mesmos clientes, só que de jeitos diferentes: um em linhas, o outro em colunas. O que você filtra num aparece no outro.',
          'Na tabela dá para escolher quais colunas aparecem e por qual delas ordenar — valor, última interação, temperatura, o que você usar mais.',
        ],
      },
      {
        chave: 'leads-views',
        titulo: 'Views salvas',
        paragrafos: [
          'Uma view é um jeito de olhar a carteira guardado com nome: os filtros, as colunas e a ordenação de uma vez só.',
          '"Meus quentes desta semana", "Sem contato há 10 dias", "Proposta acima de 5 mil" — salvou uma vez, volta com um clique, e o mesmo recorte vale no Kanban.',
        ],
      },
      {
        chave: 'leads-filtros',
        titulo: 'Filtros',
        paragrafos: [
          'O painel de filtros recorta por etapa, responsável, temperatura, período e pelos campos que a sua empresa criou.',
          'Vale combinar filtros: eles se somam, e o resultado é o que você vê tanto na tabela quanto no Kanban.',
        ],
      },
      {
        chave: 'leads-exportar',
        titulo: 'Levar a lista para fora',
        paragrafos: [
          'Quando precisar da lista em planilha, use o Exportar CSV na barra do Kanban: ele respeita os filtros ativos e baixa exatamente o recorte que você montou.',
        ],
      },
    ],
  },
  {
    id: 'followup',
    titulo: 'Follow-up',
    icone: Megaphone,
    resumo:
      'O jeito de voltar a falar com muita gente que parou de responder, sem passar a tarde copiando e colando mensagem.',
    onde: 'Menu lateral → Follow-up IA',
    topicos: [
      {
        chave: 'followup-campanha',
        titulo: 'O que é uma campanha',
        paragrafos: [
          'Você escolhe quem entra — por etapa do funil, por tempo parado —, define o que dizer e o CRM manda uma mensagem por vez, no ritmo que você determinar.',
          'A campanha mostra quantos ainda estão na fila, o intervalo entre um envio e outro e o limite do dia. As mensagens saem pelo seu número de WhatsApp, e a resposta do cliente cai na conversa normal, para você assumir dali.',
        ],
      },
      {
        chave: 'followup-modo',
        titulo: 'Texto fixo ou mensagem personalizada',
        paragrafos: [
          'No modo Texto fixo, todo mundo recebe a mesma mensagem — só o primeiro nome e a saudação mudam de acordo com quem recebe e com a hora do dia.',
          'No modo personalizado, você diz a intenção ("retomar o orçamento sem pressionar") e cada cliente recebe um texto escrito para ele, a partir da conversa que vocês já tiveram. Dá para ver uma prévia antes de disparar.',
          'Se a sua conta ainda não tem um modelo de IA configurado, o modo personalizado fica indisponível e o Texto fixo continua funcionando normalmente.',
        ],
      },
      {
        chave: 'followup-janela',
        titulo: 'Janela de disparo',
        paragrafos: [
          'O follow-up só envia dentro do horário configurado em Configurações → Geral, no horário de Brasília.',
          'Fora dessa janela a fila espera: nada se perde e nenhum cliente recebe oferta de madrugada. O envio volta sozinho assim que a janela abre de novo.',
        ],
      },
    ],
  },
  {
    id: 'dashboard',
    titulo: 'Dashboard',
    icone: BarChart3,
    resumo:
      'Os números da operação: quantos leads existem em cada etapa, como a equipe está indo e quanto a carteira deve fechar.',
    onde: 'Menu lateral → Dashboard (e Analytics, para o histórico)',
    topicos: [
      {
        chave: 'dash-funil',
        titulo: 'Funil',
        paragrafos: [
          'Mostra quantos clientes existem em cada etapa e onde a fila engrossa.',
          'Etapa cheia costuma ser um aviso: ou entrou muita gente de uma vez, ou alguma coisa está travando a passagem para a etapa seguinte.',
        ],
      },
      {
        chave: 'dash-desempenho',
        titulo: 'Desempenho',
        paragrafos: [
          'Acompanha o trabalho do dia a dia: quanto tempo a equipe leva para responder, quantas conversas foram abertas e quantas viraram venda.',
          'Serve para comparar períodos e enxergar quem precisa de ajuda antes que o mês acabe.',
        ],
      },
      {
        chave: 'dash-previsao',
        titulo: 'Financeiro e previsão ponderada',
        paragrafos: [
          'Cada etapa do funil tem uma chance de fechar: quem está em negociação avançada fecha mais do que quem acabou de chegar.',
          'A previsão ponderada não soma o valor cheio de todo mundo. Ela pesa o valor de cada negociação pela chance da etapa em que ela está. Um orçamento de R$ 10.000 numa etapa com 30% de chance entra como R$ 3.000 na conta.',
          'Por isso a previsão fica perto do que costuma acontecer de verdade, em vez do cenário em que todo mundo compra. Você ajusta essas chances no editor de funil, no campo "Chance de fechar (%)" de cada etapa; deixando o campo vazio, o CRM usa um valor automático.',
        ],
      },
    ],
  },
  {
    id: 'ajustes',
    titulo: 'Ajustes',
    icone: Settings,
    resumo:
      'Onde o gerente configura como o CRM se comporta: horários, equipe, funil, automações e os números conectados.',
    onde: 'Menu lateral → Configurações',
    topicos: [
      {
        chave: 'ajustes-janela',
        titulo: 'Janela de disparo do follow-up',
        paragrafos: [
          'Em Geral você define a que horas o follow-up automático pode enviar e em quais dias.',
          'É o freio que garante que nenhum cliente receba mensagem de madrugada ou no domingo, se você não quiser.',
        ],
      },
      {
        chave: 'ajustes-temperatura',
        titulo: 'IA ajusta a temperatura dos leads',
        paragrafos: [
          'A chave que liga a temperatura automática. Ligada, a ficha atualiza frio/morno/quente sozinha conforme a conversa evolui, e registra cada mudança na linha do tempo do lead.',
          'Desligada, a leitura aparece só como sugestão e ninguém mexe na temperatura sem você.',
        ],
      },
      {
        chave: 'ajustes-equipe',
        titulo: 'Equipe e setores',
        paragrafos: [
          'Aqui entram e saem as pessoas do time, e cada uma recebe o papel que define o que enxerga e o que pode fazer.',
          'Os setores organizam quem atende o quê, e são a base do rodízio: com a distribuição automática ligada, cada lead novo vai para o próximo atendente do setor, em revezamento.',
          'Também em Geral fica o modelo de atendimento: um número para o time inteiro, com todos podendo assumir os leads, ou um número por atendente, cada um com a sua carteira.',
        ],
      },
      {
        chave: 'ajustes-funil',
        titulo: 'Funil e campos',
        paragrafos: [
          'O editor de funil é onde nascem as etapas: nome, cor, ordem, quais contam como ganho ou perda e a chance de fechar de cada uma.',
          'É lá também que se define o que o CRM cobra dos vendedores — os campos da ficha e quais deles são obrigatórios.',
        ],
      },
      {
        chave: 'ajustes-integracoes',
        titulo: 'Integrações',
        paragrafos: [
          'Em Instâncias ficam os números de WhatsApp conectados: é onde se lê o QR Code e se acompanha se o número está no ar.',
          'Nas outras abas de Configurações ficam os webhooks, o rastreamento de origem dos leads, a checagem de duplicados e as chaves de API, para quando outro sistema precisa conversar com o CRM.',
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

const ACENTOS = new RegExp('[' + '\u0300-\u036f' + ']', 'g');

/** "João" acha "joao" e vice-versa: acento nunca some com um resultado. */
function achatar(valor: string): string {
  // Regex montada de escape ASCII: o arquivo nunca carrega marca de
  // combinacao solta, que qualquer editor distraido apagaria.
  return valor.normalize('NFD').replace(ACENTOS, '').toLowerCase();
}

/** Texto de um topico, ja achatado — titulo mais corpo, tudo pesquisavel. */
function textoDoTopico(topico: Topico): string {
  return achatar(`${topico.titulo} ${topico.paragrafos.join(' ')}`);
}

interface AreaFiltrada {
  area: Area;
  topicos: Topico[];
}

/**
 * Filtra por termo. Uma area entra inteira quando o proprio nome dela casa
 * (quem digita "radar" quer a secao toda, nao um pedaco); caso contrario,
 * entra so com os topicos que casam.
 */
function filtrar(termo: string): AreaFiltrada[] {
  if (termo === '') return AREAS.map((area) => ({ area, topicos: area.topicos }));

  const saida: AreaFiltrada[] = [];
  for (const area of AREAS) {
    const cabecalho = achatar(`${area.titulo} ${area.resumo} ${area.onde}`);
    if (cabecalho.includes(termo)) {
      saida.push({ area, topicos: area.topicos });
      continue;
    }
    const topicos = area.topicos.filter((t) => textoDoTopico(t).includes(termo));
    if (topicos.length > 0) saida.push({ area, topicos });
  }
  return saida;
}

// ---------------------------------------------------------------------------
// Accordion (disclosure simples — o projeto nao tem o Accordion do shadcn)
// ---------------------------------------------------------------------------

function ItemAccordion({
  topico,
  aberto,
  onAlternar,
}: {
  topico: Topico;
  aberto: boolean;
  onAlternar: () => void;
}) {
  const idCorpo = `ajuda-corpo-${topico.chave}`;

  return (
    <div className="border-b border-border last:border-b-0">
      <h3>
        <button
          type="button"
          onClick={onAlternar}
          aria-expanded={aberto}
          aria-controls={idCorpo}
          className={cn(
            'flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium transition-colors',
            'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          )}
        >
          <span>{topico.titulo}</span>
          <ChevronDown
            aria-hidden
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
              aberto && 'rotate-180',
            )}
          />
        </button>
      </h3>
      {/* Renderiza so quando aberto: o Ctrl+F do navegador nao acha texto
          escondido de propostas fechadas, e a busca da pagina ja cobre isso. */}
      {aberto && (
        <div id={idCorpo} className="space-y-2 px-4 pb-4 pt-0">
          {topico.paragrafos.map((paragrafo, indice) => (
            <p
              key={`${topico.chave}-p${indice}`}
              className="text-sm leading-relaxed text-muted-foreground"
            >
              {paragrafo}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagina
// ---------------------------------------------------------------------------

export default function AjudaPage() {
  const [busca, setBusca] = useState('');
  /** So o que o usuario abriu. Com busca ativa, o resultado ja abre sozinho. */
  const [abertos, setAbertos] = useState<Record<string, boolean>>({});

  const termo = achatar(busca.trim());
  const buscando = termo !== '';
  const areas = useMemo(() => filtrar(termo), [termo]);

  const alternar = (chave: string) => {
    setAbertos((atual) => ({ ...atual, [chave]: !(atual[chave] ?? buscando) }));
  };

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Como funciona o CRM"
        subtitle="Um guia rápido de cada tela, em português de gente — sem manual de 80 páginas"
      />

      {/* Busca */}
      <div className="relative max-w-xl">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Procurar por assunto: lembrete, temperatura, previsão…"
          aria-label="Procurar na ajuda"
          className="h-10 pl-9 pr-9"
        />
        {busca !== '' && (
          <button
            type="button"
            onClick={() => setBusca('')}
            aria-label="Limpar busca"
            className={cn(
              'absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Atalhos para as areas — o indice do manual. */}
      {!buscando && (
        <nav aria-label="Áreas do guia" className="flex flex-wrap gap-2">
          {AREAS.map((area) => {
            const Icone = area.icone;
            return (
              <Button key={area.id} variant="outline" size="sm" asChild>
                <a href={`#${area.id}`}>
                  <Icone aria-hidden className="mr-1.5 h-4 w-4" />
                  {area.titulo}
                </a>
              </Button>
            );
          })}
        </nav>
      )}

      {areas.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Nada encontrado para “{busca.trim()}”. Tente outra palavra — por exemplo{' '}
          <strong>lembrete</strong>, <strong>funil</strong> ou <strong>follow-up</strong>.
        </p>
      ) : (
        <div className="space-y-6">
          {areas.map(({ area, topicos }) => {
            const Icone = area.icone;
            return (
              <section
                key={area.id}
                id={area.id}
                // A ancora nao pode nascer embaixo do header fixo do dashboard.
                className="scroll-mt-20 overflow-hidden rounded-xl border border-border bg-card"
                aria-labelledby={`ajuda-titulo-${area.id}`}
              >
                <header className="border-b border-border px-4 py-4">
                  <div className="flex items-center gap-2">
                    <Icone aria-hidden className="h-5 w-5 shrink-0 text-primary" />
                    <h2 id={`ajuda-titulo-${area.id}`} className="text-base font-semibold">
                      {area.titulo}
                    </h2>
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    {area.resumo}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{area.onde}</p>
                </header>
                <div>
                  {topicos.map((topico) => (
                    <ItemAccordion
                      key={topico.chave}
                      topico={topico}
                      // Com busca ativa o resultado ja nasce aberto: quem
                      // procurou quer LER a resposta, nao clicar de novo.
                      aberto={abertos[topico.chave] ?? buscando}
                      onAlternar={() => alternar(topico.chave)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <p className="pb-2 text-center text-xs text-muted-foreground">
        Ficou faltando alguma coisa? Fale com quem cuida do CRM na sua empresa — este guia cresce
        junto com as telas.
      </p>
    </div>
  );
}
