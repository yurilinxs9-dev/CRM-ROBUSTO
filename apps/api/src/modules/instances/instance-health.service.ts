import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PushService } from '../push/push.service';

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

  /** Ciclos consecutivos caída necessários pra abrir alerta. */
  private static readonly CICLOS_PARA_ALERTAR = 2;
  private static readonly TIMEOUT_MS = 5000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly push: PushService,
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
      if (r.reconectadas || r.alertas) {
        this.logger.log(
          `monitor de instâncias: ${r.verificadas} verificada(s), ` +
            `${r.reconectadas} reconectada(s), ${r.alertas} alerta(s)`,
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
  }> {
    const instances = (await this.prisma.whatsappInstance.findMany({
      where: { tenant: { suspended_at: null } },
      select: {
        id: true,
        nome: true,
        status: true,
        tenant_id: true,
        config: true,
        tenant: { select: { nome: true, suspended_at: true } },
      },
    })) as InstanceRow[];

    let verificadas = 0;
    let reconectadas = 0;
    let alertas = 0;

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
          this.logger.debug(`instância ${inst.nome}: estado desconhecido (rede) — ignorada`);
          continue;
        }
        verificadas++;

        if (estado === 'open') {
          await this.marcarStatus(inst.id, 'open');
          this.quedas.delete(inst.id);
          await this.resolverAlerta(inst.id, inst);
          continue;
        }

        // Caída (close ou presa em connecting): tenta religar sozinha antes de
        // incomodar alguém.
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

    return { verificadas, reconectadas, alertas };
  }

  /**
   * Fecha o alerta aberto da instância e avisa que voltou. Público porque os
   * handlers de webhook chamam na transição close/connecting → open — assim a
   * recuperação aparece na hora, sem esperar o próximo ciclo do cron.
   */
  async resolverAlerta(instanceId: string, conhecida?: InstanceRow): Promise<void> {
    this.quedas.delete(instanceId);
    const aberto = await this.prisma.instanceAlert.findFirst({
      where: { instance_id: instanceId, resolvido_em: null },
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
        tenant_id: true,
        config: true,
        tenant: { select: { nome: true, suspended_at: true } },
      },
    })) as InstanceRow | null);
    if (!inst) return;

    const texto = `Instância ${inst.nome} (${inst.tenant.nome}) reconectou.`;
    await this.avisarAdmins('Instância reconectada', texto, inst.id);
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
        // QR na resposta = NÃO reconectou (precisa de gente com o celular).
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
      const conectou =
        data?.status?.connected === true ||
        data?.status?.loggedIn === true ||
        data?.connected === true ||
        data?.instance?.status === 'connected';
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
      where: { instance_id: inst.id, resolvido_em: null },
      select: { id: true },
    });
    if (aberto) return false; // UM alerta por queda.

    await this.prisma.instanceAlert.create({
      data: {
        tenant_id: inst.tenant_id,
        instance_id: inst.id,
        tipo: 'desconectada',
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
