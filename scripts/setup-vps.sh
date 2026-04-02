#!/bin/bash
# CRM WhatsApp — Setup VPS
# Ubuntu 24.04 | Execute: ssh root@<VPS_IP> && bash setup-vps.sh

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[$(date +%H:%M:%S)] $1${NC}"; }
warn() { echo -e "${YELLOW}[WARN] $1${NC}"; }

log "=== CRM WhatsApp — Setup VPS ==="

# 1. Atualizar sistema
log "Atualizando sistema..."
apt update && apt upgrade -y
apt install -y curl wget git htop nano ufw fail2ban rsync

# 2. Docker
if ! command -v docker &> /dev/null; then
  log "Instalando Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker && systemctl start docker
else
  log "Docker já instalado: $(docker --version)"
fi
if ! docker compose version &>/dev/null; then
  apt install -y docker-compose-plugin
fi
log "Docker Compose: $(docker compose version)"

# 3. Firewall
log "Configurando firewall..."
ufw allow ssh
ufw allow 80/tcp
ufw allow 3001/tcp
ufw allow 8080/tcp
ufw allow 3002/tcp
ufw --force enable
ufw status

# 4. Estrutura
log "Criando estrutura..."
mkdir -p /opt/crm-whatsapp/{nginx,logs,backups,scripts}
cd /opt/crm-whatsapp

# 5. .env de produção (preencher CHANGE_ME com valores reais)
log "Criando .env..."
cat > /opt/crm-whatsapp/.env << 'ENVEOF'
# Supabase
SUPABASE_URL=CHANGE_ME
SUPABASE_ANON_KEY=CHANGE_ME
SUPABASE_SERVICE_ROLE_KEY=CHANGE_ME
DATABASE_URL=CHANGE_ME
DIRECT_URL=CHANGE_ME

# Upstash Redis (TLS)
UPSTASH_REDIS_TLS_URL=CHANGE_ME

# Evolution API
EVOLUTION_API_KEY=CHANGE_ME
EVOLUTION_API_URL_INTERNAL=http://evolution-api:8080

# Postgres dedicado da Evolution API
POSTGRES_EVOLUTION_PASSWORD=CHANGE_ME

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
warn ".env criado — edite /opt/crm-whatsapp/.env com suas credenciais reais antes de subir os containers!"

# 6. Backup automático
log "Configurando backup automático..."
cat > /opt/crm-whatsapp/scripts/backup.sh << 'BACKUPEOF'
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/opt/crm-whatsapp/backups
mkdir -p $BACKUP_DIR
docker run --rm \
  -v crm-whatsapp_evolution_instances:/data \
  -v $BACKUP_DIR:/backup \
  alpine tar czf /backup/evolution_$DATE.tar.gz -C /data . 2>/dev/null || true
find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete
echo "[$(date)] Backup: $DATE"
BACKUPEOF
chmod +x /opt/crm-whatsapp/scripts/backup.sh
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/crm-whatsapp/scripts/backup.sh >> /opt/crm-whatsapp/logs/backup.log 2>&1") | crontab -

# 7. fail2ban
log "Configurando fail2ban..."
cat > /etc/fail2ban/jail.local << 'F2BEOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
[sshd]
enabled = true
maxretry = 3
F2BEOF
systemctl restart fail2ban 2>/dev/null || true

log "=== SETUP CONCLUÍDO ==="
echo ""
echo -e "${YELLOW}Próximo passo: edite /opt/crm-whatsapp/.env com suas credenciais${NC}"
echo -e "${YELLOW}Depois rode localmente: bash scripts/deploy.sh${NC}"
echo ""
