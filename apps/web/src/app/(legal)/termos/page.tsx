import type { Metadata } from 'next';

import { DocumentoLegal, type Secao } from '../_components/documento-legal';
import { EMPRESA, campo } from '@/lib/legal/empresa';

export const metadata: Metadata = {
  title: 'Termos de Serviço — CRM Yurilins',
  description:
    'Condições de uso da plataforma CRM Yurilins: contratação, responsabilidades, uso aceitável do WhatsApp, integrações, recursos de inteligência artificial e encerramento.',
  alternates: { canonical: `${EMPRESA.dominioPublico}/termos` },
};

// ---------------------------------------------------------------------------
// Conteudo
// ---------------------------------------------------------------------------

/**
 * Termos de servico.
 *
 * Escritos para o cliente CONTRATANTE (a empresa que usa o CRM para atender),
 * nao para o consumidor final que conversa com ela pelo WhatsApp — esse e
 * coberto pela Politica de Privacidade.
 *
 * A secao de uso aceitavel nao e enfeite: quando a conta passa a usar a API
 * oficial da Meta, e o CRM que responde perante a plataforma pelo que os
 * clientes fazem com ela. Disparo sem opt-in derruba o numero do cliente e
 * mancha o nosso App. Por isso a proibicao esta no contrato, e nao so numa
 * recomendacao de suporte.
 */
const SECOES: Secao[] = [
  {
    id: 'aceitacao',
    titulo: 'Aceitação destes Termos',
    paragrafos: [
      `Estes Termos de Serviço regem o uso do ${EMPRESA.nomeProduto} ("plataforma" ou "serviço"), oferecido por ${campo(EMPRESA.razaoSocial, 'razão social')}, inscrita no CNPJ ${campo(EMPRESA.cnpj, 'CNPJ')} ("nós").`,
      'Ao criar uma conta, acessar ou usar a plataforma, a empresa contratante e cada um dos seus usuários declaram ter lido, entendido e aceito integralmente estas condições. Quem aceita em nome de uma empresa declara ter poderes para obrigá-la.',
      'Se você não concorda com algum ponto, não use o serviço.',
    ],
  },
  {
    id: 'servico',
    titulo: 'O que a plataforma faz',
    paragrafos: [
      'A plataforma centraliza o atendimento por WhatsApp, organiza oportunidades comerciais em funil de vendas e oferece recursos de automação, relatórios e apoio por inteligência artificial.',
      'Podemos evoluir, alterar ou descontinuar funcionalidades ao longo do tempo. Quando a mudança for relevante e afetar de forma significativa o uso contratado, avisaremos previamente pelos canais de contato cadastrados.',
      'A plataforma é uma ferramenta de trabalho: ela não garante resultado comercial, volume de vendas nem desempenho de equipe.',
    ],
  },
  {
    id: 'conta',
    titulo: 'Conta, usuários e credenciais',
    paragrafos: [
      'A empresa contratante é responsável por cadastrar seus usuários, definir os perfis de acesso de cada um e revogar o acesso de quem deixa a equipe.',
      'As credenciais são pessoais e intransferíveis. A empresa contratante responde por tudo que for feito com as credenciais dos seus usuários, salvo se comprovar falha nossa.',
      'Suspeitando de acesso indevido, a empresa contratante deve trocar as senhas afetadas e nos comunicar imediatamente.',
      'As informações de cadastro devem ser verdadeiras e mantidas atualizadas.',
    ],
  },
  {
    id: 'planos-pagamento',
    titulo: 'Planos, pagamento e suspensão',
    paragrafos: [
      'O valor, a periodicidade e a forma de pagamento são os definidos na proposta comercial aceita pela empresa contratante.',
      'O atraso no pagamento pode levar à suspensão do acesso à plataforma após aviso prévio. Durante a suspensão, o envio e o recebimento de mensagens são interrompidos e os dados permanecem armazenados, aguardando a regularização.',
      'A suspensão por inadimplência não extingue os valores devidos no período.',
      'Regularizado o pagamento, o acesso é restabelecido sem perda do histórico, respeitados os prazos da seção sobre encerramento.',
    ],
  },
  {
    id: 'uso-aceitavel',
    titulo: 'Uso aceitável',
    paragrafos: [
      'Ao usar a plataforma, a empresa contratante e seus usuários se comprometem a NÃO:',
    ],
    lista: [
      {
        termo: 'Enviar mensagens sem autorização do destinatário',
        texto:
          'É proibido disparar mensagens para listas compradas, extraídas de terceiros ou obtidas sem o consentimento de quem vai recebê-las. Toda comunicação iniciada por você deve ter base legal e um caminho claro para o contato pedir para não ser mais procurado — pedido que deve ser atendido.',
      },
      {
        termo: 'Violar as regras da Meta e do WhatsApp',
        texto:
          'O uso do serviço está sujeito às políticas da Plataforma de Negócios do WhatsApp, à Política de Comércio e aos Termos da Meta. O descumprimento pode levar ao bloqueio do número pela própria Meta, e essa consequência está fora do nosso controle.',
      },
      {
        termo: 'Enviar conteúdo ilícito ou abusivo',
        texto:
          'Inclui fraude, golpe, declaração enganosa sobre a própria identidade, conteúdo que viole direitos de terceiros, discurso de ódio, material sexual envolvendo menores ou qualquer conteúdo vedado por lei.',
      },
      {
        termo: 'Comprometer a segurança ou a estabilidade do serviço',
        texto:
          'É proibido tentar obter acesso não autorizado, contornar limites de uso, fazer engenharia reversa, sobrecarregar a infraestrutura ou usar automações que prejudiquem outros clientes.',
      },
      {
        termo: 'Revender ou sublicenciar sem autorização',
        texto:
          'O acesso é concedido à empresa contratante para uso próprio. Revenda, sublicenciamento ou disponibilização a terceiros exigem autorização prévia e por escrito.',
      },
      {
        termo: 'Registrar dados sensíveis sem base legal',
        texto:
          'Campos personalizados e anotações não devem ser usados para armazenar dados de saúde, biométricos, religiosos, políticos ou equivalentes sem base legal adequada e avaliação própria de risco.',
      },
    ],
    fecho: [
      'Podemos suspender imediatamente o acesso, independentemente de aviso prévio, diante de indício concreto de violação desta seção, de risco à segurança da plataforma ou de exigência de autoridade competente ou da própria Meta. Sempre que possível, comunicaremos o motivo e o caminho para regularização.',
    ],
  },
  {
    id: 'dados-do-cliente',
    titulo: 'Dados e conteúdo da empresa contratante',
    paragrafos: [
      'Os dados que a empresa contratante insere ou gera na plataforma — conversas, contatos, leads, arquivos e configurações — continuam sendo dela. Não adquirimos propriedade sobre esse conteúdo.',
      'Tratamos esses dados na condição de operadores, para executar o serviço, conforme detalhado na Política de Privacidade.',
      'A empresa contratante é a controladora desses dados perante a LGPD e responde por ter base legal para tratá-los, por informar os titulares e por atender aos pedidos de exercício de direitos que receber. Damos o suporte técnico necessário para viabilizar esse atendimento.',
    ],
  },
  {
    id: 'integracoes',
    titulo: 'Integrações de terceiros',
    paragrafos: [
      'A plataforma depende de serviços operados por terceiros, entre eles a Meta Platforms, provedores de gateway de WhatsApp, infraestrutura em nuvem e provedores de modelos de inteligência artificial.',
      'Indisponibilidade, mudança de regra, alteração de preço, limitação de recursos ou bloqueio impostos por esses terceiros podem afetar o funcionamento do serviço. Faremos esforços razoáveis para restabelecer ou contornar, mas não respondemos por decisões tomadas por eles.',
      'Especificamente quanto ao WhatsApp: a aprovação, a manutenção e o eventual bloqueio de uma conta ou de um número são decisões da Meta, tomadas segundo critérios dela. Não temos ingerência sobre essas decisões e não podemos garanti-las.',
    ],
  },
  {
    id: 'ia',
    titulo: 'Recursos de inteligência artificial',
    paragrafos: [
      'A plataforma oferece recursos que usam modelos de linguagem para resumir conversas, sugerir respostas, classificar interesse e identificar compromissos citados pelo cliente.',
      'Esses resultados são sugestões. Podem conter erros, omissões ou imprecisões, e a decisão sobre usá-los é sempre da pessoa que atende. A empresa contratante é responsável pelo conteúdo que efetivamente envia aos seus clientes, tenha ele sido sugerido pela plataforma ou não.',
      'Não garantimos exatidão, adequação a finalidade específica nem ausência de viés nos resultados gerados por inteligência artificial.',
    ],
  },
  {
    id: 'disponibilidade',
    titulo: 'Disponibilidade e suporte',
    paragrafos: [
      'Empregamos esforços razoáveis para manter a plataforma disponível, mas o serviço é fornecido "no estado em que se encontra", sem garantia de funcionamento ininterrupto ou livre de erros.',
      'Poderá haver interrupção programada para manutenção, atualização ou correção de segurança. Quando a parada for planejada e relevante, avisaremos com antecedência razoável.',
      'O suporte é prestado pelos canais informados na contratação, em dias úteis e no horário comercial, salvo condição diversa acordada por escrito.',
    ],
  },
  {
    id: 'responsabilidade',
    titulo: 'Limitação de responsabilidade',
    paragrafos: [
      'Não respondemos por lucros cessantes, perda de oportunidade comercial, perda de clientes ou danos indiretos decorrentes do uso ou da impossibilidade de uso da plataforma.',
      'Não respondemos por bloqueio, restrição ou encerramento de número ou conta aplicados pela Meta ou por provedor de gateway, nem por indisponibilidade causada por terceiros, caso fortuito ou força maior.',
      'Ressalvadas as hipóteses em que a lei não admite limitação, nossa responsabilidade total fica limitada ao valor pago pela empresa contratante nos 12 meses anteriores ao evento que der origem à reclamação.',
      'Nada nestes Termos afasta direitos que a legislação aplicável reconheça como irrenunciáveis.',
    ],
  },
  {
    id: 'encerramento',
    titulo: 'Encerramento e devolução dos dados',
    paragrafos: [
      'A empresa contratante pode encerrar o contrato a qualquer tempo, mediante comunicação pelos canais de contato, respeitados os prazos e as condições da proposta comercial aceita.',
      'Podemos encerrar o contrato em caso de violação destes Termos não sanada após notificação, de inadimplência prolongada ou de determinação de autoridade competente.',
      'Encerrado o contrato, a empresa contratante pode solicitar a exportação dos seus dados em até 30 dias contados do encerramento. Decorrido esse prazo, os dados poderão ser definitivamente eliminados dos nossos sistemas, ressalvado o que devamos reter por obrigação legal.',
      'A eliminação é irreversível. Recomendamos exportar os dados antes de encerrar.',
    ],
  },
  {
    id: 'propriedade',
    titulo: 'Propriedade intelectual',
    paragrafos: [
      'O software, a interface, a marca, a documentação e os demais elementos da plataforma são de nossa titularidade ou licenciados a nós, e permanecem protegidos pela legislação de propriedade intelectual.',
      'Estes Termos concedem à empresa contratante uma licença de uso limitada, não exclusiva, intransferível e revogável, restrita à vigência do contrato e às finalidades nele previstas.',
    ],
  },
  {
    id: 'alteracoes',
    titulo: 'Alterações destes Termos',
    paragrafos: [
      'Podemos alterar estes Termos para refletir mudanças no serviço, na legislação ou nas regras dos provedores dos quais dependemos. A data da última revisão fica indicada no topo da página.',
      'Alterações relevantes serão comunicadas com antecedência razoável pelos canais de contato cadastrados. O uso continuado da plataforma após a entrada em vigor caracteriza concordância com a nova versão.',
    ],
  },
  {
    id: 'lei-foro',
    titulo: 'Lei aplicável e foro',
    paragrafos: [
      'Estes Termos são regidos pelas leis da República Federativa do Brasil.',
      `Fica eleito o foro da comarca de ${campo(EMPRESA.foro, 'comarca/UF do foro')} para dirimir controvérsias decorrentes destes Termos, com renúncia a qualquer outro, por mais privilegiado que seja, ressalvadas as hipóteses de competência legal diversa.`,
    ],
  },
  {
    id: 'contato',
    titulo: 'Contato',
    paragrafos: [
      `Dúvidas sobre estes Termos, sobre a contratação ou sobre o suporte: ${campo(EMPRESA.emailSuporte, 'e-mail de suporte')}.`,
      `Assuntos de privacidade e proteção de dados: ${campo(EMPRESA.emailPrivacidade, 'e-mail de privacidade')}.`,
      `Endereço: ${campo(EMPRESA.endereco, 'endereço da sede')}.`,
    ],
  },
];

export default function TermosDeServicoPage() {
  return (
    <DocumentoLegal
      titulo="Termos de Serviço"
      resumo="As condições que regem a contratação e o uso da plataforma pelas empresas que a utilizam para atender seus clientes."
      secoes={SECOES}
    />
  );
}
