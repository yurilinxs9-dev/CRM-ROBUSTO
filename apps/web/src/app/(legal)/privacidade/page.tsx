import type { Metadata } from 'next';

import { DocumentoLegal, type Secao } from '../_components/documento-legal';
import { EMPRESA, campo } from '@/lib/legal/empresa';

export const metadata: Metadata = {
  title: 'Política de Privacidade — CRM Yurilins',
  description:
    'Como o CRM Yurilins coleta, usa, compartilha e protege dados pessoais, incluindo os dados tratados na integração com a Plataforma de Negócios do WhatsApp.',
  alternates: { canonical: `${EMPRESA.dominioPublico}/privacidade` },
};

// ---------------------------------------------------------------------------
// Conteudo
// ---------------------------------------------------------------------------

/**
 * Politica de privacidade.
 *
 * Duas coisas a manter em mente ao editar este texto:
 *
 * 1. O CRM e multi-tenant. Para os dados de CADASTRO do cliente contratante ele
 *    e controlador; para as CONVERSAS e leads que o cliente traz, ele e
 *    operador — quem decide o que fazer com aquele dado e o contratante. Essa
 *    distincao esta no artigo 5 da LGPD e e justamente a parte que uma politica
 *    generica erra. Nao simplifique a secao "papeis".
 * 2. Cada afirmacao aqui corresponde a um comportamento real do codigo. Os
 *    prazos de retencao saem de `data-retention.service.ts`; a lista de
 *    terceiros sai dos servicos que a aplicacao de fato chama. Se o
 *    comportamento mudar, o texto muda junto — uma politica que descreve um
 *    sistema que nao existe e exposicao, nao protecao.
 */
const SECOES: Secao[] = [
  {
    id: 'quem-somos',
    titulo: 'Quem somos',
    paragrafos: [
      `Esta Política de Privacidade descreve como ${campo(EMPRESA.razaoSocial, 'razão social')}, inscrita no CNPJ ${campo(EMPRESA.cnpj, 'CNPJ')}, com sede em ${campo(EMPRESA.endereco, 'endereço da sede')}, trata dados pessoais na operação do ${EMPRESA.nomeProduto} ("CRM", "plataforma" ou "serviço").`,
      'O CRM é uma plataforma de gestão de atendimento e vendas que centraliza conversas de WhatsApp, organiza oportunidades em funil e apoia equipes comerciais com automações e recursos de inteligência artificial.',
      'Este documento segue a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018 — LGPD) e as políticas da Plataforma de Negócios do WhatsApp e da Meta Platforms aplicáveis a quem integra seus serviços.',
    ],
  },
  {
    id: 'papeis',
    titulo: 'Nosso papel: quando somos controladores e quando somos operadores',
    paragrafos: [
      'A plataforma é contratada por empresas, que a usam para atender os próprios clientes. Isso cria duas relações distintas, com responsabilidades diferentes — e é importante saber em qual delas você está.',
    ],
    lista: [
      {
        termo: 'Somos controladores dos dados da conta',
        texto:
          'Em relação aos dados de cadastro e uso da empresa contratante e dos seus usuários — nome, e-mail, telefone, cargo, credenciais de acesso, registros de acesso e dados de cobrança — somos nós que decidimos as finalidades e os meios do tratamento. É a nós que você recorre para exercer seus direitos sobre esses dados.',
      },
      {
        termo: 'Somos operadores dos dados dos seus contatos',
        texto:
          'Em relação às conversas, contatos, leads e arquivos que a empresa contratante traz para dentro da plataforma, agimos por conta e ordem dela. Quem decide por que aqueles dados são tratados, por quanto tempo ficam e com quem são compartilhados é a empresa contratante, na condição de controladora. Tratamos esses dados apenas para executar o serviço e conforme as instruções dela.',
      },
    ],
    fecho: [
      'Na prática: se você conversou por WhatsApp com uma empresa que usa o CRM e quer saber o que ela guarda sobre você, corrigir um dado ou pedir exclusão, o pedido deve ser dirigido a essa empresa — ela é a controladora daquela conversa. Se ela nos acionar, damos o suporte técnico necessário para atender o pedido. Você também pode nos escrever diretamente, e nós encaminharemos a solicitação à empresa responsável.',
    ],
  },
  {
    id: 'dados-coletados',
    titulo: 'Dados que tratamos',
    paragrafos: ['A plataforma trata as seguintes categorias de dados pessoais:'],
    lista: [
      {
        termo: 'Dados de cadastro e acesso',
        texto:
          'Nome, e-mail, telefone, função na equipe, senha (armazenada apenas como hash, nunca em texto legível), preferências de uso, sessões ativas e registros de acesso à aplicação, incluindo data, hora e endereço IP.',
      },
      {
        termo: 'Conteúdo das conversas de WhatsApp',
        texto:
          'Mensagens enviadas e recebidas, arquivos anexados (imagens, vídeos, áudios, documentos), número de telefone dos participantes, nome exibido no perfil ou na agenda do aparelho conectado, horários e status de entrega e leitura. Esse conteúdo é espelhado no CRM para que a equipe da empresa contratante consiga atender a partir de um único lugar.',
      },
      {
        termo: 'Dados comerciais do lead',
        texto:
          'Informações que a equipe registra sobre a oportunidade: etapa do funil, valor estimado, origem, responsável pelo atendimento, etiquetas, anotações internas, tarefas, lembretes e campos personalizados criados pela própria empresa contratante — que podem incluir dados adicionais que ela decida coletar.',
      },
      {
        termo: 'Dados de origem e atribuição',
        texto:
          'Quando o contato chega por um anúncio ou por um link rastreado, registramos a campanha, o conjunto e o criativo de origem, os parâmetros de rastreamento da URL e o horário do clique, para que a empresa contratante saiba de onde vieram seus clientes.',
      },
      {
        termo: 'Dados técnicos e de diagnóstico',
        texto:
          'Registros de erro, eventos recebidos das integrações, chamadas feitas à nossa API e informações do navegador ou dispositivo necessárias para operar e depurar o serviço, incluindo o registro de inscrição para notificações push, quando você as autoriza.',
      },
    ],
    fecho: [
      'Não pedimos e não temos interesse em dados sensíveis (origem racial ou étnica, convicção religiosa, opinião política, dado referente à saúde ou à vida sexual, dado genético ou biométrico). A empresa contratante não deve usar campos personalizados nem anotações para registrar esse tipo de informação sem base legal própria e adequada.',
    ],
  },
  {
    id: 'finalidades',
    titulo: 'Para que usamos esses dados',
    paragrafos: ['Tratamos dados pessoais para as seguintes finalidades:'],
    lista: [
      {
        termo: 'Prestar o serviço contratado',
        texto:
          'Enviar e receber mensagens, manter o histórico de conversas, organizar leads no funil, distribuir atendimentos entre a equipe, gerar relatórios e executar as automações configuradas pela empresa contratante. Base legal: execução de contrato.',
      },
      {
        termo: 'Autenticar e proteger o acesso',
        texto:
          'Verificar identidade no login, manter sessões, aplicar permissões por perfil e registrar quem fez o quê, para auditoria e investigação de incidentes. Base legal: execução de contrato e legítimo interesse em segurança.',
      },
      {
        termo: 'Operar, corrigir e melhorar a plataforma',
        texto:
          'Monitorar disponibilidade, diagnosticar falhas, evitar abuso e aprimorar funcionalidades. Base legal: legítimo interesse.',
      },
      {
        termo: 'Gerar apoio inteligente ao atendimento',
        texto:
          'Produzir resumos de conversa, sugestões de resposta, classificação de interesse do lead, sugestão de etapa do funil e lembretes extraídos do que o cliente disse. A seção sobre inteligência artificial detalha como isso funciona.',
      },
      {
        termo: 'Cobrança e relacionamento com a empresa contratante',
        texto:
          'Emitir cobranças, comunicar vencimentos, suspender ou reativar o acesso e prestar suporte. Base legal: execução de contrato e cumprimento de obrigação legal.',
      },
      {
        termo: 'Cumprir obrigações legais e regulatórias',
        texto:
          'Atender determinação de autoridade competente e guardar registros exigidos por lei. Base legal: cumprimento de obrigação legal.',
      },
    ],
  },
  {
    id: 'whatsapp-meta',
    titulo: 'Integração com o WhatsApp e a Meta',
    paragrafos: [
      'O CRM se conecta ao WhatsApp para enviar e receber mensagens em nome da empresa contratante. Nessa conexão, os dados necessários à entrega das mensagens — números de telefone, conteúdo e anexos — trafegam pela infraestrutura da Meta Platforms, Inc. e ficam sujeitos também às políticas dela.',
      'A empresa contratante é responsável por ter base legal para falar com cada contato e por respeitar as regras da Plataforma de Negócios do WhatsApp, incluindo a obrigação de obter consentimento antes de iniciar conversas e de oferecer um caminho claro para o contato pedir para não ser mais procurado.',
      'Não usamos o conteúdo das conversas para publicidade, não o vendemos e não o cedemos a terceiros para finalidades próprias deles.',
    ],
    fecho: [
      'Quando a conexão é feita por provedores de gateway de WhatsApp contratados por nós ou pela empresa contratante, esses provedores também processam as mensagens em trânsito, na condição de suboperadores, e estão sujeitos a obrigações contratuais de confidencialidade e segurança.',
    ],
  },
  {
    id: 'inteligencia-artificial',
    titulo: 'Uso de inteligência artificial',
    paragrafos: [
      'Alguns recursos da plataforma analisam o conteúdo das conversas por meio de modelos de linguagem, para produzir resumos, sugestões de resposta, classificação de interesse do lead e lembretes de compromissos citados pelo próprio cliente.',
      'Para isso, trechos das conversas podem ser enviados a provedores de modelos de inteligência artificial contratados por nós. Esse envio é limitado ao necessário para gerar o resultado pedido e acontece sob contrato que veda o uso do conteúdo para treinamento de modelos dos provedores.',
      'Parte desse processamento ocorre em modelo executado na nossa própria infraestrutura, sem que o conteúdo saia dela. Quando o recurso depende de um provedor externo, aplicam-se as condições do parágrafo anterior.',
    ],
    fecho: [
      'Os resultados gerados por inteligência artificial são sugestões de apoio à decisão humana. Eles não substituem a avaliação da equipe de atendimento e podem conter imprecisões.',
    ],
  },
  {
    id: 'compartilhamento',
    titulo: 'Com quem compartilhamos dados',
    paragrafos: [
      'Não vendemos dados pessoais. Compartilhamos dados apenas com quem é necessário para o serviço funcionar, sempre limitado à finalidade correspondente:',
    ],
    lista: [
      {
        termo: 'Meta Platforms, Inc.',
        texto:
          'Para o envio e o recebimento de mensagens pelo WhatsApp e para a atribuição de contatos originados de anúncios.',
      },
      {
        termo: 'Provedores de infraestrutura em nuvem',
        texto:
          'Hospedagem da aplicação, banco de dados e armazenamento de arquivos, incluindo os anexos das conversas.',
      },
      {
        termo: 'Provedores de gateway de WhatsApp',
        texto:
          'Serviços que intermedeiam a conexão com o WhatsApp, quando essa for a forma de conexão escolhida para a instância.',
      },
      {
        termo: 'Provedores de modelos de inteligência artificial',
        texto:
          'Conforme descrito na seção sobre inteligência artificial, exclusivamente para gerar o recurso solicitado.',
      },
      {
        termo: 'Autoridades públicas',
        texto:
          'Quando houver determinação legal, ordem judicial ou requisição de autoridade competente.',
      },
      {
        termo: 'Sucessores em operações societárias',
        texto:
          'Em caso de fusão, aquisição ou reorganização, mediante comunicação prévia e mantidas as obrigações desta Política.',
      },
    ],
    fecho: [
      'Todos os operadores contratados por nós estão sujeitos a obrigações de confidencialidade, segurança da informação e uso restrito à finalidade que justificou o acesso.',
    ],
  },
  {
    id: 'transferencia-internacional',
    titulo: 'Transferência internacional de dados',
    paragrafos: [
      'Parte da infraestrutura que utilizamos está localizada fora do Brasil, inclusive nos Estados Unidos. Isso significa que dados pessoais tratados na plataforma podem ser armazenados ou processados no exterior.',
      'Essas transferências são feitas com amparo no artigo 33 da LGPD, mediante cláusulas contratuais e garantias de proteção compatíveis com o padrão exigido pela legislação brasileira.',
    ],
  },
  {
    id: 'retencao',
    titulo: 'Por quanto tempo guardamos',
    paragrafos: ['O prazo de guarda varia conforme a natureza do dado:'],
    lista: [
      {
        termo: 'Conversas, leads e arquivos',
        texto:
          'Ficam disponíveis enquanto durar o contrato com a empresa contratante, porque é ela quem define a necessidade de manter o histórico. Encerrado o contrato, aplica-se o prazo da seção sobre encerramento dos Termos de Serviço.',
      },
      {
        termo: 'Registros brutos recebidos das integrações',
        texto:
          'São apagados automaticamente após 7 dias. Servem apenas para diagnóstico técnico recente.',
      },
      {
        termo: 'Metadados técnicos anexados às mensagens',
        texto:
          'A cópia bruta recebida do provedor é removida automaticamente após 30 dias, preservando-se a mensagem e as informações necessárias ao funcionamento da plataforma.',
      },
      {
        termo: 'Dados de cadastro e registros de acesso',
        texto:
          'São mantidos durante a vigência do contrato e, depois dele, pelos prazos exigidos pela legislação aplicável, entre eles o do Marco Civil da Internet para registros de acesso a aplicação.',
      },
    ],
  },
  {
    id: 'seguranca',
    titulo: 'Segurança da informação',
    paragrafos: [
      'Adotamos medidas técnicas e administrativas para proteger os dados contra acesso não autorizado, perda, alteração e divulgação indevida. Entre elas:',
    ],
    lista: [
      {
        termo: 'Comunicação criptografada',
        texto: 'Todo o tráfego entre navegador, aplicação e integrações usa canal cifrado (TLS).',
      },
      {
        termo: 'Senhas e segredos protegidos',
        texto:
          'Senhas são guardadas apenas como hash com algoritmo de derivação lenta. Credenciais de integração são cifradas em repouso e nunca devolvidas pela interface depois de salvas.',
      },
      {
        termo: 'Acesso a arquivos por link temporário',
        texto:
          'Anexos das conversas não são públicos: o acesso se dá por endereços assinados, com prazo de validade.',
      },
      {
        termo: 'Separação por cliente e por perfil',
        texto:
          'Os dados de cada empresa contratante são isolados logicamente e, dentro dela, o acesso é limitado pelo perfil de cada usuário.',
      },
      {
        termo: 'Registro de auditoria',
        texto:
          'Ações administrativas sensíveis ficam registradas, com autor e data, para permitir apuração.',
      },
    ],
    fecho: [
      'Nenhum sistema é imune a incidentes. Caso ocorra incidente de segurança com risco relevante aos titulares, comunicaremos a empresa contratante e a Autoridade Nacional de Proteção de Dados nos termos do artigo 48 da LGPD.',
    ],
  },
  {
    id: 'direitos',
    titulo: 'Seus direitos',
    paragrafos: [
      'A LGPD garante ao titular, entre outros, o direito de obter confirmação da existência de tratamento; acessar seus dados; corrigir dados incompletos, inexatos ou desatualizados; solicitar anonimização, bloqueio ou eliminação de dados desnecessários ou tratados em desconformidade; pedir a portabilidade; revogar o consentimento; e ser informado sobre com quem seus dados foram compartilhados.',
      `Para exercer qualquer desses direitos, escreva para ${campo(EMPRESA.emailPrivacidade, 'e-mail de privacidade')}. Responderemos no prazo legal, podendo solicitar informações adicionais para confirmar sua identidade — essa verificação existe para impedir que um terceiro obtenha seus dados se passando por você.`,
      'Se o pedido se referir a dados que tratamos como operadores, em nome de uma empresa contratante, encaminharemos a solicitação a ela, que é a controladora, e informaremos você sobre esse encaminhamento.',
    ],
  },
  {
    id: 'exclusao',
    titulo: 'Como pedir a exclusão dos seus dados',
    paragrafos: [
      `Para solicitar a exclusão de dados pessoais, envie um e-mail para ${campo(EMPRESA.emailPrivacidade, 'e-mail de privacidade')} com o assunto "Exclusão de dados" e informe o número de telefone ou o e-mail associado ao seu registro.`,
      'Confirmada a identidade, eliminamos os dados sob nossa responsabilidade em até 30 dias, salvo os que precisamos reter por obrigação legal ou para exercício regular de direitos em processo, hipóteses previstas no artigo 16 da LGPD. Nesse caso, informaremos o que foi retido e por quê.',
      'Se seus dados estiverem na base de uma empresa contratante que usa a plataforma, repassaremos o pedido a ela e daremos o suporte técnico necessário para que a exclusão seja efetivada.',
    ],
  },
  {
    id: 'cookies',
    titulo: 'Cookies e armazenamento local',
    paragrafos: [
      'Usamos cookies e armazenamento local do navegador apenas para o funcionamento da aplicação: manter sua sessão autenticada, lembrar preferências de visualização e permitir o funcionamento do aplicativo instalável.',
      'Não utilizamos cookies de publicidade nem rastreamento de comportamento em sites de terceiros. Bloquear os cookies essenciais impede o login e o uso da plataforma.',
    ],
  },
  {
    id: 'menores',
    titulo: 'Crianças e adolescentes',
    paragrafos: [
      'A plataforma é uma ferramenta de trabalho, destinada a maiores de 18 anos. Não coletamos intencionalmente dados de crianças e adolescentes. Se identificarmos esse tipo de dado sem a base legal adequada, ele será eliminado.',
    ],
  },
  {
    id: 'alteracoes',
    titulo: 'Alterações nesta Política',
    paragrafos: [
      'Esta Política pode ser atualizada para refletir mudanças na plataforma, na legislação ou nas práticas de tratamento. A data da última revisão fica indicada no topo da página.',
      'Quando a alteração for relevante, comunicaremos as empresas contratantes pelos canais de contato cadastrados antes de a nova versão entrar em vigor.',
    ],
  },
  {
    id: 'contato',
    titulo: 'Contato e Encarregado',
    paragrafos: [
      `Encarregado pelo tratamento de dados pessoais (DPO): ${campo(EMPRESA.encarregado, 'nome do encarregado/DPO')}.`,
      `E-mail para assuntos de privacidade e proteção de dados: ${campo(EMPRESA.emailPrivacidade, 'e-mail de privacidade')}.`,
      `Endereço: ${campo(EMPRESA.endereco, 'endereço da sede')}.`,
      'Você também pode apresentar reclamação à Autoridade Nacional de Proteção de Dados (ANPD).',
    ],
  },
];

export default function PoliticaPrivacidadePage() {
  return (
    <DocumentoLegal
      titulo="Política de Privacidade"
      resumo="Como tratamos dados pessoais na plataforma, incluindo os dados que passam pela integração com o WhatsApp e pelos recursos de inteligência artificial."
      secoes={SECOES}
    />
  );
}
