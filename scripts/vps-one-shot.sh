#!/bin/bash
# CRM WhatsApp — Setup + Deploy completo na VPS em 1 comando
# Rodar NA VPS: bash vps-one-shot.sh
# ANTES de rodar: preencha todas as variáveis CHANGE_ME abaixo
set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[$(date +%H:%M:%S)] $1${NC}"; }
warn() { echo -e "${YELLOW}[WARN] $1${NC}"; }

log "=== CRM WhatsApp — Setup + Deploy VPS ==="

# 1. Sistema
log "Atualizando sistema..."
apt-get update -qq && apt-get upgrade -y -qq
apt-get install -y -qq curl wget git htop nano ufw fail2ban rsync

# 2. Docker
if ! command -v docker &>/dev/null; then
  log "Instalando Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker && systemctl start docker
else
  log "Docker: $(docker --version)"
fi
if ! docker compose version &>/dev/null; then
  apt-get install -y docker-compose-plugin
fi

# 3. Firewall
log "Configurando firewall..."
ufw allow ssh
ufw allow 80/tcp
ufw allow 3001/tcp
ufw allow 3002/tcp
ufw --force enable

# 4. Estrutura
log "Criando estrutura de diretórios..."
mkdir -p /opt/crm-whatsapp/{apps/api,nginx,logs,backups,scripts}

# 5. .env
log "Criando .env de produção..."
# IMPORTANTE: preencha os valores CHANGE_ME com suas credenciais reais
cat > /opt/crm-whatsapp/.env << 'ENVEOF'
# Supabase
SUPABASE_URL=CHANGE_ME
SUPABASE_ANON_KEY=CHANGE_ME
SUPABASE_SERVICE_ROLE_KEY=CHANGE_ME
DATABASE_URL=CHANGE_ME
DIRECT_URL=CHANGE_ME

# Redis (in-cluster container `crm-redis` from docker-compose.yml)
REDIS_URL=redis://crm-redis:6379

# JWT
JWT_SECRET=CHANGE_ME
JWT_REFRESH_SECRET=CHANGE_ME
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# Webhook
WEBHOOK_SECRET=CHANGE_ME

# App
NODE_ENV=production
PORT=3001
FRONTEND_URL=CHANGE_ME
SUPABASE_STORAGE_BUCKET=crm-media
FFMPEG_PATH=/usr/bin/ffmpeg
ENVEOF
chmod 600 /opt/crm-whatsapp/.env
warn ".env criado com placeholders — edite /opt/crm-whatsapp/.env com suas credenciais reais antes de subir os containers!"

# 6. fail2ban
log "Configurando fail2ban..."
cat > /etc/fail2ban/jail.local << 'F2B'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
[sshd]
enabled = true
maxretry = 3
F2B
systemctl restart fail2ban 2>/dev/null || true

# ┌─────────────────────────────────────────────────────────────────────┐
# │ Backup automation disabled                                          │
# │ Old target volume `crm-whatsapp_evolution_instances` no longer      │
# │ exists. Re-enable after deciding new strategy:                      │
# │   - Redis dump: docker exec crm-redis redis-cli SAVE + cp dump.rdb  │
# │   - Supabase: managed PITR (paid tier)                              │
# │   - VPS-level: Hostinger snapshot API                               │
# │ Until then, this VPS has NO automated backup.                       │
# └─────────────────────────────────────────────────────────────────────┘
# # 7. Backup cron
# cat > /opt/crm-whatsapp/scripts/backup.sh << 'BKEOF'
# #!/bin/bash
# DATE=$(date +%Y%m%d_%H%M%S)
# BACKUP_DIR=/opt/crm-whatsapp/backups
# mkdir -p $BACKUP_DIR
# docker run --rm \
#   -v crm-whatsapp_evolution_instances:/data \
#   -v $BACKUP_DIR:/backup \
#   alpine tar czf /backup/evolution_$DATE.tar.gz -C /data . 2>/dev/null || true
# find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete
# echo "[$(date)] Backup: $DATE"
# BKEOF
# chmod +x /opt/crm-whatsapp/scripts/backup.sh
# (crontab -l 2>/dev/null; echo "0 3 * * * /opt/crm-whatsapp/scripts/backup.sh >> /opt/crm-whatsapp/logs/backup.log 2>&1") | crontab -

log "=== Setup base concluído! ==="
log "Próximos passos:"
echo ""
echo -e "${YELLOW}  1. Edite /opt/crm-whatsapp/.env com suas credenciais reais${NC}"
echo -e "${YELLOW}  2. Rode o deploy a partir do seu computador: bash scripts/deploy.sh${NC}"
echo ""
