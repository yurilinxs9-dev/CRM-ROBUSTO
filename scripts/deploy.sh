#!/bin/bash
# CRM WhatsApp — Deploy backend na VPS
# Executar LOCALMENTE: bash scripts/deploy.sh
# Requer: ssh configurado para root@187.127.11.117
#
# O /opt/crm-whatsapp na VPS é um clone git deste repositório, então o deploy é
# `git pull` + rebuild da imagem. Versões antigas deste script sincronizavam por
# rsync, o que sujava o working tree da VPS e travava o pull seguinte.
#
# MIGRATIONS NÃO RODAM AQUI. O _prisma_migrations deste banco está poluído
# (~121 linhas, ~47 com finished_at nulo, mais drift pré-existente), então
# `prisma migrate deploy` falha com P3009 — e com `set -e` derrubava o deploy no
# meio. O fluxo correto está no CLAUDE.md: SQL só-de-objetos-novos aplicada por
# script em transação + `prisma migrate resolve --applied <nome>`.

set -e
VPS="root@187.127.11.117"
VPS_DIR="/opt/crm-whatsapp"
BRANCH="master"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[DEPLOY $(date +%H:%M:%S)] $1${NC}"; }
warn() { echo -e "${YELLOW}[WARN] $1${NC}"; }
die()  { echo -e "${RED}$1${NC}"; exit 1; }

# No Git Bash, o `ssh` que vem do Git não enxerga o ssh-agent do Windows, que é
# quem guarda a chave do VPS — a conexão falha com "Permission denied" mesmo com
# a chave carregada. Nesse caso usamos o OpenSSH nativo. Sobrescrevível por
# SSH_BIN=/caminho/ssh, para quem roda em WSL ou Linux com outro setup.
if [ -z "${SSH_BIN:-}" ]; then
  SSH_BIN="ssh"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      [ -x "/c/Windows/System32/OpenSSH/ssh.exe" ] && SSH_BIN="/c/Windows/System32/OpenSSH/ssh.exe"
      ;;
  esac
fi
# Chave específica opcional (ex.: VPS_SSH_KEY=~/.ssh/claude_vps_crm bash scripts/deploy.sh).
SSH_OPTS=()
if [ -n "${VPS_SSH_KEY:-}" ]; then
  SSH_OPTS=(-i "$VPS_SSH_KEY" -o IdentitiesOnly=yes)
fi
ssh_vps() { "$SSH_BIN" "${SSH_OPTS[@]}" "$VPS" "$@"; }

log "=== Deploy CRM WhatsApp → $VPS ==="

# 0. O que a VPS vai puxar é o que está no remoto — commits locais não pushados
#    não chegariam lá, e o deploy "passaria" sem conter a mudança.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  die "Erro: rode a partir do repositório."
fi
git fetch origin "$BRANCH" --quiet || die "Erro: não foi possível consultar o remoto."
AHEAD=$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)
if [ "$AHEAD" != "0" ]; then
  die "Erro: $AHEAD commit(s) local(is) sem push. Rode 'git push origin $BRANCH' antes."
fi
if [ -n "$(git status --porcelain)" ]; then
  warn "Working tree local com alterações não commitadas — elas NÃO vão para a VPS."
fi

# 1. Verificar SSH
if ! "$SSH_BIN" "${SSH_OPTS[@]}" -o ConnectTimeout=8 "$VPS" "echo OK" >/dev/null 2>&1; then
  die "Erro: não foi possível conectar ao VPS. Verifique SSH."
fi

# 2. Atualizar o código na VPS
log "Atualizando repositório na VPS..."
# O `npm install --omit=dev` do passo 3 reescreve o package-lock.json na VPS, ou
# seja, todo deploy deixa o working tree sujo e travaria o pull do deploy
# seguinte. Esse arquivo é descartável lá (é regerado): restauramos.
#
# Outras alterações manuais na VPS (ex.: nginx/nginx.conf ajustado à mão,
# backups .env.before-*) são preservadas: o pull --ff-only só falha se a release
# mexe num arquivo alterado lá. Só esse caso para o script — descartar sem
# perguntar poderia apagar um hotfix. Arquivos fora do git são ignorados.
ssh_vps "cd $VPS_DIR && git checkout -- package-lock.json 2>/dev/null || true"
ssh_vps "cd $VPS_DIR && git fetch --quiet origin $BRANCH"
CONFLITO=$(ssh_vps "cd $VPS_DIR && for f in \$(git diff --name-only); do git diff --quiet HEAD origin/$BRANCH -- \"\$f\" || echo \"\$f\"; done")
if [ -n "$CONFLITO" ]; then
  warn "A release altera arquivos que foram mudados à mão na VPS — o pull vai falhar:"
  echo "$CONFLITO"
  die "Resolva na VPS (git checkout -- <arquivo> ou git stash) e rode de novo."
fi
MANUAIS=$(ssh_vps "cd $VPS_DIR && git diff --name-only | head -5")
[ -n "$MANUAIS" ] && warn "Alterações manuais preservadas na VPS: $(echo $MANUAIS)"
ssh_vps "cd $VPS_DIR && git pull --ff-only origin $BRANCH" | tail -3
REMOTE_SHA=$(ssh_vps "cd $VPS_DIR && git rev-parse --short HEAD")
log "VPS em $REMOTE_SHA"

# 3. Dependências + Prisma Client
log "Instalando dependências e gerando Prisma client..."
ssh_vps "cd $VPS_DIR/apps/api && npm install --omit=dev >/dev/null && npx prisma generate >/dev/null"

# 4. Migrations — deliberadamente NÃO automatizadas (ver cabeçalho)
PENDING=$(ssh_vps "ls -1 $VPS_DIR/apps/api/prisma/migrations 2>/dev/null | tail -1")
log "Última pasta de migration no repo: ${PENDING:-nenhuma}"
warn "Migrations não são aplicadas por este script. Se esta release traz schema novo,"
warn "aplique pelo fluxo do CLAUDE.md ANTES de seguir (script .mjs + migrate resolve)."

# 5. Build da imagem
log "Buildando imagem crm-backend..."
ssh_vps "cd $VPS_DIR && docker compose build crm-backend" | tail -2

# 6. Subir só o backend. `docker compose up -d` sem serviço tentava criar
#    também o `nginx` do compose (crm-nginx): em nov/2026 o nome estava ocupado
#    por um container antigo, o comando abortava no meio e deixava o
#    crm-backend recriado mas PARADO (produção fora do ar). O tráfego entra pelo
#    túnel da Cloudflare direto no backend; o deploy só reconstrói o backend.
log "Subindo crm-backend..."
ssh_vps "cd $VPS_DIR && docker compose up -d --no-deps crm-backend" | tail -3

# 7. Health com retentativa — o container leva alguns segundos para responder
log "Verificando health..."
HEALTH="000"
for i in 1 2 3 4 5 6; do
  sleep 5
  # `|| echo 000` dentro do $() concatenaria com o que o curl já imprimiu
  # ("000000"). Fallback fora da substituição.
  HEALTH=$(ssh_vps "curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/api/health" 2>/dev/null) || HEALTH="000"
  [ -n "$HEALTH" ] || HEALTH="000"
  [ "$HEALTH" = "200" ] && break
  log "  tentativa $i: HTTP $HEALTH"
done

if [ "$HEALTH" = "200" ]; then
  log "Backend OK ✓ (HTTP $HEALTH)"
else
  warn "Backend health: HTTP $HEALTH — últimas linhas do log:"
  ssh_vps "cd $VPS_DIR && docker compose logs crm-backend --tail 30"
  die "Deploy terminou com backend fora do ar."
fi

# 8. Evolution API
EVO_STATUS=$(ssh_vps "set -a; . $VPS_DIR/.env; set +a; curl -s -o /dev/null -w '%{http_code}' \
  -H \"apikey: \$EVOLUTION_API_KEY\" \
  http://localhost:8080/instance/fetchInstances" 2>/dev/null) || EVO_STATUS="000"
if [ "$EVO_STATUS" = "200" ]; then
  log "Evolution API OK ✓ (HTTP $EVO_STATUS)"
else
  warn "Evolution API: HTTP $EVO_STATUS"
fi

# 9. Status final
echo ""
ssh_vps "cd $VPS_DIR && docker compose ps --format 'table {{.Name}}\t{{.Status}}'"
echo ""
log "=== Deploy concluído — $REMOTE_SHA ==="
echo ""
echo -e "${GREEN}URLs:${NC}"
echo "  API Health:    http://187.127.11.117:3001/api/health"
echo "  Evolution API: http://187.127.11.117:8080"
echo "  Uptime Kuma:   http://187.127.11.117:3002"
echo ""
echo -e "${GREEN}Frontend:${NC} Vercel deploya sozinho no push para $BRANCH."
