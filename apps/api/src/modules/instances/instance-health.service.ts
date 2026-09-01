import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PushService } from '../push/push.service';
import { HistorySyncService } from '../webhooks/history-sync.service';
import { LogThrottle, INSTANCIA_DESCONHECIDA_JANELA_MS } from '../webhooks/log-throttle';

/** Mesmo shape lido pelo InstancesService (config Json da instância). */
interface InstanceConfig {
  uazapi_token?: string;
  uazapi_id?: string;
  provider?: 'uazapi' | 'evolution';
  evolution_token?: string;
  evolution_base_url?: string;
  [key: string]: unknown;
}

interface InstanceRow {
  id: string;
  nome: string;
  status: string;
  telefone: string | null;
  tenant_id: string;
  config: unknown;
  tenant: { nome: string; suspended_at: Date | null };
}

interface UazStatusResponse {
  instance?: { status?: string; qrcode?: string };
  status?: { connected?: boolean; loggedIn?: boolean; jid?: string | null };
  connected?: boolean;
}

interface EvoStateResponse {
  instance?: { state?: string };
}

interface EvoConnectResponse {
  base64?: string;
  code?: string;
  qrcode?: { base64?: string; code?: string };
  instance?: { state?: string };
}

/** open = saudável; connecting/close = caída; desconhecido = gateway mudo. */
type EstadoGateway = 'open' | 'connecting' | 'close' | 'desconhecido';

interface ContadorQueda {
  ciclos: number;
  /** Quando a queda foi vista pela 1ª vez (vira `aberto_em` do alerta). */
  desde: Date;
}

/**
 * Monitor de saúde das instâncias de WhatsApp.
 *
 * Nasceu de um incidente real: o número central da Cajuru caiu e ficou 2 dias
 * fora sem ninguém perceber — o status no banco continuava "open" porque o
 * gateway parou de mandar webhook. A cada 5 min este cron pergunta ao gateway
 * o status REAL de cada instância, religa sozinha o que dá pra religar e só
 * incomoda o admin quando a única saída é ler um QR novo.
 *
 * Regras que o cron respeita (spec):
 *  - toda chamada ao gateway tem timeout de 5s; erro de rede é estado
 *    DESCONHECIDO — não mexe no status do banco, não conta ciclo de queda e
 *    não alerta (internet ruim ≠ WhatsApp caído);
 *  - instância de tenant suspenso e provider legado WPPConnect (config sem
 *    uazapi_token e sem evolution_token) ficam de fora;
 *  - anti-flap: alerta só depois de 2 ciclos consecutivos caída (≥10 min) E
 *    sem alerta aberto — UM alerta por queda;
 *  - cada instância roda no seu try/catch: nada derruba o loop.
 *
 * O contador de ciclos consecutivos vive em memória (`Map`). Reinício do
 * processo zera o contador: na prática só atrasa um alerta em um ciclo (5 min),
 * e é o trade-off aceito no plano pra não escrever estado de flap no banco.
 */
@Injectable()
export class InstanceHealthService {
  private readonly logger = new Logger(InstanceHealthService.name);
  private readonly uazBaseUrl: string;
  private readonly evoBaseUrl: string;
  private running = false;

  /** Ciclos consecutivos caída por instância (anti-flap, em memória). */
  private readonly quedas = new Map<string, ContadorQueda>();
  /** Ciclos consecutivos de estado desconhecido (gateway mudo) por instância. */
  private readonly desconhecidos = new Map<string, number>();
  /** Um warn por instância cega a cada 10min (mesmo padrão dos handlers). */
  private readonly avisoCega = new LogThrottle(INSTANCIA_DESCONHECIDA_JANELA_MS);
  /**
   * Instâncias com alerta de silêncio aberto POR ESTE processo — é o que
   * autoriza fechar a linha quando o inbound volta, sem um findFirst extra por
   * instância a cada ciclo. Perder o Set no restart só deixa a linha aberta
   * (nada no produto lê), que é o comportamento de antes.
   */
  private readonly silenciosAbertos = new Set<string>();

  /** Ciclos consecutivos caída necessários pra abrir alerta. */
  private static readonly CICLOS_PARA_ALERTAR = 2;
  /** Ciclos consecutivos sem resposta do gateway antes de gritar no log. */
  private static readonly CICLOS_PARA_AVISAR_CEGA = 3;
  private static readonly TIMEOUT_MS = 5000;

  /** Sem mensagem de CLIENTE por mais que isto = silêncio suspeito. */
  private static readonly SILENCIO_INBOUND_MS = 6 * 3_600_000;
  /** Janela de baseline (antes da janela de silêncio) que prova movimento. */
  private static readonly BASELINE_MS = 7 * 24 * 3_600_000;
  /** Mínimo de INCOMING no baseline pra instância ser "movimentada". */
  private static readonly BASELINE_MINIMO = 10;
  /** No máximo um alerta+sync de silêncio por instância nesta janela. */
  private static readonly COOLDOWN_SILENCIO_MS = 6 * 3_600_000;
  private static readonly TIPO_SILENCIO = 'inbound_silencioso';
  private static readonly TIPO_QUEDA = 'desconectada';
  /**
   * Eventos que provam que o inbound FUNCIONARIA — mensagem de verdade
   * (inclusive `fromMe`, que foi o que continuou chegando no incidente).
   * `presence`/`connection`/`chats` não entram: de madrugada, com a loja
   * fechada, eles pingam sozinhos e abririam alerta de silêncio todo dia.
   * ACK (`*_update`, `message_ack`) também fica de fora: é eco de disparo
   * nosso, não prova nada sobre o caminho de entrada.
   */
  private static readonly EVENTOS_DE_MENSAGEM = [
    'uazapi.messages',
    'uazapi.message',
    'messages.upsert',
    'onmessage',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly push: PushService,
    private readonly historySync: HistorySyncService,
  ) {
    this.uazBaseUrl = this.config.get<string>('UAZAPI_BASE_URL', 'https://jgtech.uazapi.com');
    this.evoBaseUrl = this.config.get<string>('EVOLUTION_BASE_URL', '');
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async cron(): Promise<void> {
    // Guard de reentrância: com muitas instâncias uma varredura pode passar de
    // 5 min; duas rodando juntas dobrariam chamadas ao gateway e contariam o
    // mesmo ciclo de queda duas vezes (alerta prematuro).
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.verificarTodas();
      if (r.reconectadas || r.alertas || r.silencios) {
        this.logger.log(
          `monitor de instâncias: ${r.verificadas} verificada(s), ` +
            `${r.reconectadas} reconectada(s), ${r.alertas} alerta(s), ` +
            `${r.silencios} sem inbound`,
        );
      }
    } catch (err: unknown) {
      this.logger.warn(`monitor de instâncias falhou: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  async verificarTodas(): Promise<{
    verificadas: number;
    reconectadas: number;
    alertas: number;
    silencios: number;
  }> {
    const instances = (await this.prisma.whatsappInstance.findMany({
      where: { tenant: { suspended_at: null } },
      select: {
        id: true,
        nome: true,
        status: true,
        telefone: true,
        tenant_id: true,
        config: true,
        tenant: { select: { nome: true, suspended_at: true } },
      },
    })) as InstanceRow[];

    let verificadas = 0;
    let reconectadas = 0;
    let alertas = 0;
    let silencios = 0;

    for (const inst of instances) {
      const cfg = (inst.config ?? {}) as InstanceConfig;
      // Redundante com o where (mocks/consultas futuras podem não filtrar),
      // mas suspenso nunca entra no monitor.
      if (inst.tenant.suspended_at) continue;
      // WPPConnect legado: sem token conhecido não há gateway pra perguntar.
      if (!cfg.uazapi_token && !cfg.evolution_token) continue;

      try {
        const estado = await this.consultarEstado(inst, cfg);
        if (estado === 'desconhecido') {
          // Gateway mudo/rede ruim: NÃO é queda. Não escreve status, não conta
          // ciclo — senão uma oscilação de rede abriria alerta falso.
          this.avisarCega(inst);
          continue;
        }
        this.desconhecidos.delete(inst.id);
        verificadas++;

        if (estado === 'open') {
          await this.marcarStatus(inst.id, 'open');
          this.quedas.delete(inst.id);
          await this.resolverAlerta(inst.id, inst);
          if (await this.checarSilencioInbound(inst, cfg)) silencios++;
          continue;
        }

        // Instância que NUNCA foi pareada não caiu: nunca existiu sessão. É o
        // QR criado e abandonado (ou o dialog aberto agora esperando alguém
        // escanear). Só atualiza o status; sem reconexão, sem contador, sem
        // alerta — e em `connecting` isso é vital: o POST /instance/connect
        // re-emitiria o QR e invalidaria o código que a pessoa está lendo
        // nesse instante, com o cron sabotando o pareamento.
        if (!(await this.jaPareada(inst))) {
          await this.marcarStatus(inst.id, estado);
          this.quedas.delete(inst.id);
          continue;
        }

        // Caída de verdade (close, ou instância pareada presa em connecting):
        // tenta religar sozinha antes de incomodar alguém.
        const voltou = await this.tentarReconectar(inst, cfg);
        if (voltou) {
          await this.marcarStatus(inst.id, 'open');
          this.quedas.delete(inst.id);
          await this.resolverAlerta(inst.id, inst);
          reconectadas++;
          continue;
        }

        await this.marcarStatus(inst.id, estado);
        const anterior = this.quedas.get(inst.id);
        const contador: ContadorQueda = anterior
          ? { ciclos: anterior.ciclos + 1, desde: anterior.desde }
          : { ciclos: 1, desde: new Date() };
        this.quedas.set(inst.id, contador);

        if (contador.ciclos >= InstanceHealthService.CICLOS_PARA_ALERTAR) {
          const abriu = await this.abrirAlerta(inst, contador.desde);
          if (abriu) alertas++;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `monitor: instância ${inst.nome} falhou: ${String((err as Error)?.message ?? err)}`,
        );
      }
    }

    return { verificadas, reconectadas, alertas, silencios };
  }

  /**
   * Detector de silêncio de inbound (incidente 28→31/08/2026).
   *
   * O servidor UazAPI parou de entregar webhook de mensagem de CLIENTE — só
   * `fromMe` continuou chegando. As instâncias ficaram `open` o tempo todo, o
   * check de status acima não viu nada, o history sync (gatilho: reconexão)
   * também não, e clientes ficaram três dias sem resposta.
   *
   * O sinal é a combinação: nenhum INCOMING há ≥6h ENQUANTO o canal de webhook
   * da instância continua vivo (WebhookLog recente). Sem webhook nenhum a
   * instância está parada de verdade — isso é a queda de sempre, tratada
   * acima, e este alerta fica quieto pra não duplicar.
   *
   * O baseline (≥10 INCOMING nos 7 dias ANTERIORES à janela) é o que mantém
   * fora do alerta a instância nova, a de teste e a que simplesmente não
   * recebe nada de madrugada.
   *
   * Cooldown de 6h no próprio InstanceAlert (`aberto_em`, tipo
   * `inbound_silencioso`) e não em memória como o contador anti-flap: numa
   * pane de dias o backend é redeployado várias vezes, e um Map zerado a cada
   * restart viraria alerta+sync repetidos. A linha do alerta só é fechada
   * quando o inbound volta (`fecharSilencio`, sem notificação) — por isso
   * `resolverAlerta`/`abrirAlerta`, que falam de QUEDA, são escopados ao tipo
   * `desconectada`.
   *
   * @returns true quando alertou (e disparou o sync) neste ciclo.
   */
  private async checarSilencioInbound(
    inst: InstanceRow,
    cfg: InstanceConfig,
  ): Promise<boolean> {
    const agora = Date.now();
    const janela = new Date(agora - InstanceHealthService.SILENCIO_INBOUND_MS);

    const ultimo = await this.prisma.message.findFirst({
      where: {
        tenant_id: inst.tenant_id,
        instance_name: inst.nome,
        direction: 'INCOMING',
      },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    });
    // Cliente falou dentro da janela: canal saudável, sai barato.
    if (ultimo && ultimo.created_at.getTime() >= janela.getTime()) {
      await this.fecharSilencio(inst);
      return false;
    }

    // Cooldown antes das consultas caras: numa pane que dura dias este ramo é
    // o que roda a cada 5 min.
    const recente = await this.prisma.instanceAlert.findFirst({
      where: {
        instance_id: inst.id,
        tipo: InstanceHealthService.TIPO_SILENCIO,
        aberto_em: { gte: new Date(agora - InstanceHealthService.COOLDOWN_SILENCIO_MS) },
      },
      select: { id: true },
    });
    if (recente) return false;

    // Prova de que o canal está vivo e só o inbound sumiu. O log da UazAPI
    // grava ora o nome, ora o id da instância — os dois identificadores valem.
    const identificadores = [inst.nome, typeof cfg.uazapi_id === 'string' ? cfg.uazapi_id : null]
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    const webhookVivo = await this.prisma.webhookLog.findFirst({
      where: {
        instance: { in: identificadores },
        event: { in: InstanceHealthService.EVENTOS_DE_MENSAGEM },
        created_at: { gte: janela },
        // Nome de instância só é único POR tenant: sem isto, a homônima de
        // outro tenant "provaria" o canal desta (bug conhecido do repo). Logs
        // antigos podem não ter tenant resolvido — esses ainda valem.
        OR: [{ tenant_id: inst.tenant_id }, { tenant_id: null }],
      },
      select: { id: true },
    });
    if (!webhookVivo) return false;

    const baseline = await this.prisma.message.count({
      where: {
        tenant_id: inst.tenant_id,
        instance_name: inst.nome,
        direction: 'INCOMING',
        created_at: {
          gte: new Date(janela.getTime() - InstanceHealthService.BASELINE_MS),
          lt: janela,
        },
      },
    });
    if (baseline < InstanceHealthService.BASELINE_MINIMO) return false;

    const horas = ultimo
      ? Math.floor((agora - ultimo.created_at.getTime()) / 3_600_000)
      : Math.floor(InstanceHealthService.SILENCIO_INBOUND_MS / 3_600_000);

    await this.prisma.instanceAlert.create({
      data: {
        tenant_id: inst.tenant_id,
        instance_id: inst.id,
        tipo: InstanceHealthService.TIPO_SILENCIO,
        aberto_em: new Date(agora),
      },
    });

    this.silenciosAbertos.add(inst.id);

    // O sync vem ANTES do aviso, e o aviso não pode derrubar o caminho: o
    // cooldown de 6h já está gravado, então uma falha aqui (banco de
    // notificação fora, push com erro) cegaria a instância justamente na pane.
    // Best-effort e em background: o sync varre 7 dias e não pode segurar o
    // ciclo do monitor nem derrubá-lo se o gateway estiver ruim.
    const sync = cfg.evolution_token
      ? this.historySync.syncEvolutionInstance(inst.id, HistorySyncService.RECONNECT_WINDOW_MS)
      : this.historySync.syncInstance(inst.id, HistorySyncService.RECONNECT_WINDOW_MS);
    void sync.catch((err: unknown) =>
      this.logger.warn(`history sync por silêncio (${inst.nome}) falhou: ${String(err)}`),
    );

    const texto =
      `Instância ${inst.nome} (${inst.tenant.nome}) conectada mas sem mensagens ` +
      `de clientes há ${horas}h — possível falha de entrega do provedor; ` +
      `sincronização de histórico disparada.`;
    try {
      await this.avisarAdmins('Instância sem mensagens recebidas', texto, inst.id);
    } catch (err: unknown) {
      this.logger.warn(`aviso de silêncio (${inst.nome}) falhou: ${String(err)}`);
    }

    this.logger.warn(
      `monitor: ${inst.nome} (${inst.tenant.nome}) sem INCOMING há ${horas}h com webhook ` +
        `ativo — alerta de silêncio aberto e history sync disparado`,
    );
    return true;
  }

  /**
   * Inbound voltou: fecha a linha do alerta de silêncio EM SILÊNCIO. Ninguém
   * é notificado — quem leu o alerta original já sabe o que aconteceu e um
   * "voltou a receber" a cada pane só faria barulho. Só escreve quando este
   * processo abriu o alerta (Set), então não é um UPDATE por ciclo.
   */
  private async fecharSilencio(inst: InstanceRow): Promise<void> {
    if (!this.silenciosAbertos.delete(inst.id)) return;
    await this.prisma.instanceAlert.updateMany({
      where: {
        instance_id: inst.id,
        tipo: InstanceHealthService.TIPO_SILENCIO,
        resolvido_em: null,
      },
      data: { resolvido_em: new Date() },
    });
    this.logger.log(`monitor: ${inst.nome} voltou a receber mensagens de clientes`);
  }

  /**
   * Fecha o alerta aberto da instância e avisa que voltou. Público porque os
   * handlers de webhook chamam na transição close/connecting → open — assim a
   * recuperação aparece na hora, sem esperar o próximo ciclo do cron.
   */
  async resolverAlerta(instanceId: string, conhecida?: InstanceRow): Promise<void> {
    this.quedas.delete(instanceId);
    // Só o alerta de QUEDA: "reconectou" não diz nada sobre o alerta de
    // silêncio de inbound, que nasce com a instância já conectada.
    const aberto = await this.prisma.instanceAlert.findFirst({
      where: {
        instance_id: instanceId,
        tipo: InstanceHealthService.TIPO_QUEDA,
        resolvido_em: null,
      },
      orderBy: { aberto_em: 'desc' },
    });
    if (!aberto) return;

    await this.prisma.instanceAlert.update({
      where: { id: aberto.id },
      data: { resolvido_em: new Date() },
    });

    const inst = conhecida ?? ((await this.prisma.whatsappInstance.findFirst({
      where: { id: instanceId },
      select: {
        id: true,
        nome: true,
        status: true,
        telefone: true,
        tenant_id: true,
        config: true,
        tenant: { select: { nome: true, suspended_at: true } },
      },
    })) as InstanceRow | null);
    if (!inst) return;

    const texto = `Instância ${inst.nome} (${inst.tenant.nome}) reconectou.`;
    await this.avisarAdmins('Instância reconectada', texto, inst.id);
  }

  /**
   * "Esta instância já teve sessão de WhatsApp em pé alguma vez?"
   *
   * Três sinais, do mais barato pro mais caro:
   *  - `telefone` preenchido — mas isso só acontece nos caminhos UazAPI
   *    (`importByToken`/`getQrCode`/`checkStatus` leem o jid); instância
   *    Evolution NUNCA ganha telefone hoje;
   *  - `status` = open no banco — é o retrato de AGORA: assim que a instância
   *    cai, o webhook connection.update já reescreveu pra `close`;
   *  - existe lead que entrou por este número. É o sinal durável e igual pros
   *    dois providers (índice em `Lead.instancia_whatsapp`), e é o que impede
   *    o gate de cegar o monitor justamente na instância Evolution caída —
   *    o cenário que este serviço existe pra pegar.
   *
   * Só é consultado no ramo ambíguo (instância caída, sem telefone e sem
   * status open), então não pesa no ciclo normal.
   */
  private async jaPareada(inst: InstanceRow): Promise<boolean> {
    if (inst.telefone != null || inst.status === 'open') return true;
    const lead = await this.prisma.lead.findFirst({
      where: { tenant_id: inst.tenant_id, instancia_whatsapp: inst.nome },
      select: { id: true },
    });
    return lead != null;
  }

  /**
   * Gateway calado é EXATAMENTE o modo de falha que originou este monitor: o
   * status no banco continua bonito enquanto ninguém consegue falar com a
   * instância. O log `debug` de cada ciclo não sai em produção
   * (`LOG_LEVEL=info`), então três ciclos seguidos (≥15 min) cegos viram UM
   * `warn` por instância a cada 10 min — barulhento o bastante pra alguém ver,
   * silencioso o bastante pra não inundar o log.
   */
  private avisarCega(inst: InstanceRow): void {
    const ciclos = (this.desconhecidos.get(inst.id) ?? 0) + 1;
    this.desconhecidos.set(inst.id, ciclos);
    this.logger.debug(`instância ${inst.nome}: estado desconhecido (rede) — ignorada`);
    if (ciclos < InstanceHealthService.CICLOS_PARA_AVISAR_CEGA) return;
    if (!this.avisoCega.deveLogar(`health-desconhecido:${inst.id}`)) return;
    this.logger.warn(
      `monitor: instância ${inst.nome} (${inst.tenant.nome}) sem resposta do gateway ` +
        `há ${ciclos} ciclos — status no painel pode estar desatualizado ` +
        `(próximos avisos desta instância suprimidos por 10min)`,
    );
  }

  // ── Gateways ───────────────────────────────────────────────────────────────

  private async consultarEstado(
    inst: InstanceRow,
    cfg: InstanceConfig,
  ): Promise<EstadoGateway> {
    try {
      if (cfg.evolution_token) {
        const baseUrl = cfg.evolution_base_url || this.evoBaseUrl;
        const { data } = await firstValueFrom(
          this.http.get<EvoStateResponse>(`${baseUrl}/instance/connectionState/${inst.nome}`, {
            headers: this.evoHeaders(cfg.evolution_token),
            timeout: InstanceHealthService.TIMEOUT_MS,
          }),
        );
        return this.mapearEstado(data?.instance?.state);
      }

      const { data } = await firstValueFrom(
        this.http.get<UazStatusResponse>(`${this.uazBaseUrl}/instance/status`, {
          headers: { token: cfg.uazapi_token ?? '' },
          timeout: InstanceHealthService.TIMEOUT_MS,
        }),
      );
      if (data?.status?.connected === true || data?.status?.loggedIn === true) return 'open';
      return this.mapearEstado(data?.instance?.status);
    } catch (err: unknown) {
      this.logger.debug(
        `status ${inst.nome} indisponível: ${String((err as Error)?.message ?? err)}`,
      );
      return 'desconhecido';
    }
  }

  /**
   * Religa a sessão sem intervenção humana. Só dá certo quando a sessão do
   * WhatsApp ainda é válida do outro lado; se o gateway devolve QR, é porque a
   * sessão morreu de vez e só um pareamento novo resolve.
   */
  private async tentarReconectar(inst: InstanceRow, cfg: InstanceConfig): Promise<boolean> {
    try {
      if (cfg.evolution_token) {
        const baseUrl = cfg.evolution_base_url || this.evoBaseUrl;
        const { data } = await firstValueFrom(
          this.http.get<EvoConnectResponse>(`${baseUrl}/instance/connect/${inst.nome}`, {
            headers: this.evoHeaders(cfg.evolution_token),
            timeout: InstanceHealthService.TIMEOUT_MS,
          }),
        );
        const qr = data?.base64 ?? data?.qrcode?.base64 ?? data?.code ?? data?.qrcode?.code ?? null;
        // O state é a palavra final quando vem: `connecting` SEM QR não é
        // reconexão — tratar como sucesso resolvia o alerta, dois ciclos depois
        // abria outro, e o admin levava notificação nova a cada ~15 min.
        const state = data?.instance?.state;
        if (state) return state === 'open';
        // Sem state: QR na resposta = NÃO reconectou (precisa de gente com o
        // celular); resposta limpa = sessão já de pé.
        return !qr;
      }

      const { data } = await firstValueFrom(
        this.http.post<UazStatusResponse>(
          `${this.uazBaseUrl}/instance/connect`,
          {},
          {
            headers: { token: cfg.uazapi_token ?? '' },
            timeout: InstanceHealthService.TIMEOUT_MS,
          },
        ),
      );
      // Mesma regra do Evolution: quando o gateway diz o status, ele é a
      // palavra final. `connecting` sem qrcode não é reconexão — dar sucesso
      // aqui resolveria o alerta e dois ciclos depois abriria outro, com o
      // admin levando notificação nova a cada ~15 min.
      const status = data?.instance?.status;
      if (status) return status === 'connected';
      // Sem status no corpo: os booleanos de sessão, e por último a ausência
      // de QR (resposta limpa = sessão já de pé).
      const conectou =
        data?.status?.connected === true ||
        data?.status?.loggedIn === true ||
        data?.connected === true;
      const qr = data?.instance?.qrcode ?? null;
      return conectou || !qr;
    } catch (err: unknown) {
      this.logger.debug(
        `reconexão ${inst.nome} falhou: ${String((err as Error)?.message ?? err)}`,
      );
      return false;
    }
  }

  private evoHeaders(apikey: string): Record<string, string> {
    return { 'Content-Type': 'application/json', apikey };
  }

  /**
   * Vocabulário dos dois gateways → status do banco (mesmo mapa dos handlers
   * de webhook, pra painel e monitor nunca discordarem). Estado que nenhum dos
   * dois conhece conta como caída: melhor um alerta a mais do que outro número
   * fora do ar por 2 dias.
   */
  private mapearEstado(raw: string | undefined): EstadoGateway {
    const mapa: Record<string, EstadoGateway> = {
      connected: 'open',
      open: 'open',
      connecting: 'connecting',
      disconnected: 'close',
      close: 'close',
    };
    return mapa[raw ?? ''] ?? 'close';
  }

  // ── Banco + avisos ─────────────────────────────────────────────────────────

  private async marcarStatus(instanceId: string, status: string): Promise<void> {
    await this.prisma.whatsappInstance.update({
      where: { id: instanceId },
      data: { status, ultimo_check: new Date() },
    });
  }

  /** @returns true quando o alerta foi criado agora (false = já havia um aberto). */
  private async abrirAlerta(inst: InstanceRow, desde: Date): Promise<boolean> {
    const aberto = await this.prisma.instanceAlert.findFirst({
      where: {
        instance_id: inst.id,
        tipo: InstanceHealthService.TIPO_QUEDA,
        resolvido_em: null,
      },
      select: { id: true },
    });
    if (aberto) return false; // UM alerta por queda.

    await this.prisma.instanceAlert.create({
      data: {
        tenant_id: inst.tenant_id,
        instance_id: inst.id,
        tipo: InstanceHealthService.TIPO_QUEDA,
        aberto_em: desde,
      },
    });

    const texto =
      `Instância ${inst.nome} (${inst.tenant.nome}) desconectada desde ` +
      `${this.formatarHora(desde)} — provavelmente precisa de QR novo.`;
    await this.avisarAdmins('Instância desconectada', texto, inst.id);
    return true;
  }

  /**
   * Sino + push pra todo platform admin ativo. O tenant da Notification é o do
   * próprio admin (a coluna é NOT NULL e o destinatário é quem importa).
   */
  private async avisarAdmins(titulo: string, texto: string, instanceId: string): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { ativo: true, is_platform_admin: true },
      select: { id: true, tenant_id: true },
    });
    if (admins.length === 0) return;

    for (const admin of admins) {
      await this.prisma.notification.create({
        data: {
          user_id: admin.id,
          tenant_id: admin.tenant_id,
          titulo,
          conteudo: texto,
          tipo: 'instance_alert',
          link: '/admin',
          lida: false,
        },
      });
    }

    await this.push
      .sendToUsers(
        admins.map((a) => a.id),
        { title: titulo, body: texto, url: '/admin', tag: `instancia-${instanceId}` },
      )
      .catch((err: unknown) => this.logger.warn(`push do monitor falhou: ${String(err)}`));
  }

  /** HH:mm no fuso de quem lê o painel (Brasil), não em UTC. */
  private formatarHora(d: Date): string {
    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/Sao_Paulo',
    }).format(d);
  }
}
