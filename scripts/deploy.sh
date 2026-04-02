#!/bin/bash
# CRM WhatsApp — Deploy backend na VPS
# Executar LOCALMENTE: bash scripts/deploy.sh
# Requer: ssh configurado para root@187.127.11.117

set -e
VPS="root@187.127.11.117"
VPS_DIR="/opt/crm-whatsapp"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[DEPLOY $(date +%H:%M:%S)] $1${NC}"; }
warn() { echo -e "${YELLOW}[WARN] $1${NC}"; }

log "=== Deploy CRM WhatsApp → $VPS ==="

# Verificar SSH
if ! ssh -o ConnectTimeout=5 $VPS "echo OK" &>/dev/null; then
  echo -e "${RED}Erro: Não foi possível conectar ao VPS. Verifique SSH.${NC}"
  exit 1
fi

# 1. Sincronizar backend
log "Sincronizando apps/api..."
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.env' \
  --exclude '*.log' \
  ./apps/api/ $VPS:$VPS_DIR/apps/api/

# 2. Sincronizar infra
log "Sincronizando docker-compose + nginx..."
scp ./docker-compose.yml $VPS:$VPS_DIR/docker-compose.yml
scp ./nginx/nginx.conf $VPS:$VPS_DIR/nginx/nginx.conf

# 3. Instalar dependências na VPS
log "Instalando dependências..."
ssh $VPS "cd $VPS_DIR/apps/api && npm install --omit=dev"

# 4. Gerar Prisma Client
log "Gerando Prisma client..."
ssh $VPS "cd $VPS_DIR/apps/api && npx prisma generate"

# 5. Executar migrations
log "Executando migrations no Supabase..."
ssh $VPS "cd $VPS_DIR/apps/api && \
  export \$(grep -v '^#' $VPS_DIR/.env | xargs) && \
  npx prisma migrate deploy"

# 6. Build Docker
log "Buildando imagem crm-backend..."
ssh $VPS "cd $VPS_DIR && docker compose build crm-backend"

# 7. Subir todos os containers
log "Subindo containers..."
ssh $VPS "cd $VPS_DIR && docker compose up -d"

# 8. Aguardar e verificar health
log "Verificando health (aguardando 15s)..."
sleep 15

HEALTH=$(ssh $VPS "curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/api/health" 2>/dev/null || echo "000")

if [ "$HEALTH" = "200" ]; then
  log "Backend OK ✓ (HTTP $HEALTH)"
else
  warn "Backend health: HTTP $HEALTH"
  ssh $VPS "cd $VPS_DIR && docker compose logs crm-backend --tail 30"
fi

# 9. Verificar Evolution API
EVO_STATUS=$(ssh $VPS "source $VPS_DIR/.env && curl -s -o /dev/null -w '%{http_code}' \
  -H \"apikey: \$EVOLUTION_API_KEY\" \
  http://localhost:8080/instance/fetchInstances" 2>/dev/null || echo "000")

if [ "$EVO_STATUS" = "200" ]; then
  log "Evolution API OK ✓ (HTTP $EVO_STATUS)"
else
  warn "Evolution API: HTTP $EVO_STATUS"
fi

# 10. Status final
echo ""
ssh $VPS "cd $VPS_DIR && docker compose ps"
echo ""
log "=== Deploy concluído ==="
echo ""
echo -e "${GREEN}URLs:${NC}"
echo "  API Health:    http://187.127.11.117:3001/api/health"
echo "  Evolution API: http://187.127.11.117:8080"
echo "  Uptime Kuma:   http://187.127.11.117:3002"
echo ""
echo -e "${GREEN}Próximos passos:${NC}"
echo "  1. Criar admin:  ssh $VPS 'cd $VPS_DIR/apps/api && npx ts-node src/scripts/create-admin.ts'"
echo "  2. Deploy web:   Configurar Vercel apontando para apps/web/"
