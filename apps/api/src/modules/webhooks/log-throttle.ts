/**
 * Rate-limit de LOG em memória (mesmo padrão do `ultimoRefresh` do
 * LeadInsightsService): deixa passar um aviso por chave a cada janela.
 *
 * Existe por causa da instância órfã: webhook de instância que o CRM não
 * conhece (alguém conectou direto no gateway, tenant deletado ou suspenso)
 * chega a cada mensagem, pra sempre. Sem throttle, o log vira ruído puro e
 * esconde o que importa.
 */
export class LogThrottle {
  /** chave -> timestamp do último log liberado. */
  private readonly ultimo = new Map<string, number>();

  constructor(
    private readonly janelaMs: number,
    /** Acima disso o Map é podado (processo longo, muitas chaves distintas). */
    private readonly maxEntradas = 500,
  ) {}

  /** true = pode logar agora (e marca o relógio); false = suprimir. */
  deveLogar(chave: string, agora: number = Date.now()): boolean {
    const anterior = this.ultimo.get(chave);
    if (anterior !== undefined && agora - anterior < this.janelaMs) return false;
    this.podar(agora);
    this.ultimo.set(chave, agora);
    return true;
  }

  private podar(agora: number): void {
    if (this.ultimo.size < this.maxEntradas) return;
    for (const [chave, quando] of this.ultimo) {
      if (agora - quando >= this.janelaMs) this.ultimo.delete(chave);
    }
  }
}

/** Janela padrão dos avisos de instância não mapeada: 10 minutos. */
export const INSTANCIA_DESCONHECIDA_JANELA_MS = 10 * 60 * 1000;

/**
 * Token de gateway não vai inteiro pro log (é credencial): só os 4 últimos
 * dígitos, o bastante pra identificar qual instância órfã está batendo.
 */
export function mascararToken(token: string | undefined): string {
  if (!token) return '(sem token)';
  return `***${token.slice(-4)}`;
}
