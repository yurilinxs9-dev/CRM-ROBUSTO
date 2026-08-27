# Monitor de instâncias + alertas ao admin — Design

Pedido do Yuri (27/08, após o número central da Cajuru ficar 2 dias caído sem ninguém saber): (1) quando uma instância WhatsApp desconectar, chegar aviso PARA ELE no painel de admin (para avisar o cliente com antecedência); (2) reduzir o tempo caído — o CRM deve tentar religar sozinho.

Verdade técnica registrada: a queda vem do lado do WhatsApp/celular do cliente; impedir 100% não existe. O que o CRM faz: religa sozinho quando a credencial da sessão ainda vale (`POST /instance/connect` da UazAPI reconecta sem QR nesses casos; Evolution idem via `GET /instance/connect/:nome`), e alerta em minutos quando só QR novo resolve.

## Comportamento

1. **Cron de saúde (a cada 5 min)** — para cada instância de tenant NÃO suspenso: consulta o status REAL no gateway (UazAPI `GET /instance/status` com o token da instância; Evolution `GET /instance/connectionState/:nome`). Atualiza `status` + `ultimo_check` no banco (fonte da verdade deixa de ser só o webhook). Erro de rede/timeout (5s) = estado desconhecido: NÃO alerta (gateway instável ≠ instância caída), só loga.
2. **Auto-reconexão** — instância caída (`disconnected`/`close`): tenta religar em silêncio no mesmo ciclo. Religou (resposta conectada, sem QR) → status `open`, e se havia alerta aberto, resolve + avisa recuperação. Não religou (voltou QR/erro) → segue caída.
3. **Alerta (anti-flap)** — caída em 2 ciclos consecutivos (≥10 min) E sem alerta aberto → abre `InstanceAlert` + `Notification` para todos os users `is_platform_admin` + web push (`PushService.sendToUsers`). Texto humano: "Instância {nome} ({tenant}) desconectada desde {HH:mm} — provavelmente precisa de QR novo." UM alerta por queda (nada de spam a cada ciclo).
4. **Recuperação** — status voltou a `open` (pelo cron ou pelo webhook `connection.update`): resolve o alerta aberto (`resolvido_em`) + Notification "Instância {nome} ({tenant}) reconectou".
5. **Painel admin** — endpoint `GET /admin/instances-health` (PlatformAdminGuard): TODAS as instâncias com tenant, nome, provider, status, ultimo_check, alerta aberto desde. Front `/admin`: seção "Instâncias" com as caídas no topo em vermelho (badge com contagem) e as saudáveis abaixo.

## Modelo

`InstanceAlert`: id, tenant_id (FK CASCADE), instance_id (FK CASCADE), tipo (`'desconectada'`), aberto_em (default now), resolvido_em (null = aberto), created_at/updated_at. Índices: (instance_id, resolvido_em), (resolvido_em, aberto_em).

## Fora de escopo (deliberado)

- Aviso automático AO TENANT (Yuri quer ser ele a avisar o cliente); revisitar depois.
- Alerta de gateway inteiro fora do ar (outro problema, outra rodada).
- WPPConnect legado (sem endpoint de status confiável; só UazAPI + Evolution).
