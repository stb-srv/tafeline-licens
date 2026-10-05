#!/usr/bin/env bash
# =============================================================================
#  OPA-Santorini License Server – Setup Script
#  Unterstützt: Ubuntu 22.04/24.04, Debian 12
#  Läuft als root ODER als normaler User (sudo wird bei Bedarf verwendet)
# =============================================================================
set -euo pipefail

# ── Farben ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC}  $*"; }
info() { echo -e "${BLUE}ℹ${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC}  $*" >&2; }
step() { echo -e "\n${BOLD}${CYAN}▶  $*${NC}"; }
ask()  { echo -e "${YELLOW}?${NC}  $*"; }

# ── Root-Check & sudo-Helper ──────────────────────────────────────────────────
IS_ROOT=false
[[ $EUID -eq 0 ]] && IS_ROOT=true

SUDO=""
if ! $IS_ROOT; then
    if command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
        SUDO="sudo"
    elif command -v sudo &>/dev/null; then
        SUDO="sudo"
        info "Dieses Script benötigt sudo-Rechte für Systemoperationen."
    else
        err "Kein sudo verfügbar und nicht root. Bitte als root ausführen."
        exit 1
    fi
fi

run_privileged() { $SUDO "$@"; }

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo -e "${BOLD}${CYAN}"
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║         Tafeline License Server – Setup                 ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo "  Dieses Script installiert und konfiguriert den Server"
echo "  vollständig: Node.js, nginx, systemd-Service."
echo "  Alle Secrets werden automatisch generiert."
echo "  Den Admin-Account richtest du danach im Browser ein."
echo ""

# ── Konfigurations-Variablen ──────────────────────────────────────────────────
APP_DIR="/opt/meraki-licens"
APP_USER="meraki-licens"
NODE_VERSION="20"

# ── Interaktive Eingabe ───────────────────────────────────────────────────────
step "Konfiguration"

echo ""
ask "Domain/Hostname des Servers (z.B. licens.meinrestaurant.de):"
read -r DOMAIN
DOMAIN="${DOMAIN:-localhost}"

ask "App-Verzeichnis [${APP_DIR}]:"
read -r INPUT_DIR
APP_DIR="${INPUT_DIR:-$APP_DIR}"

ask "Systemd-Service-User [${APP_USER}] (Enter = neuen User anlegen, 'root' = als root laufen):"
read -r INPUT_USER
APP_USER="${INPUT_USER:-$APP_USER}"

ask "Port für Node.js [4000]:"
read -r APP_PORT
APP_PORT="${APP_PORT:-4000}"

ask "Nginx installieren und konfigurieren? [J/n]:"
read -r SETUP_NGINX
SETUP_NGINX="${SETUP_NGINX:-J}"

ask "SSL/HTTPS mit Let's Encrypt einrichten? (nur bei echter Domain) [j/N]:"
read -r SETUP_SSL
SETUP_SSL="${SETUP_SSL:-N}"

if [[ "${SETUP_SSL^^}" == "J" ]]; then
    ask "E-Mail für Let's Encrypt Zertifikat:"
    read -r LE_EMAIL
fi

echo ""
step "Repository"
ask "Git-Repository-URL [aktuelle Verzeichnis kopieren / leer = lokale Dateien]:"
read -r GIT_REPO
GIT_REPO="${GIT_REPO:-}"

echo ""
echo -e "${BOLD}Zusammenfassung:${NC}"
echo "  App-Verzeichnis : $APP_DIR"
echo "  Domain          : $DOMAIN"
echo "  Port            : $APP_PORT"
echo "  Service-User    : $APP_USER"
echo "  Nginx           : ${SETUP_NGINX^^}"
echo "  SSL             : ${SETUP_SSL^^}"
[[ -n "$GIT_REPO" ]] && echo "  Repository      : $GIT_REPO"
echo ""
ask "Fortfahren? [J/n]:"
read -r CONFIRM
[[ "${CONFIRM:-J}" =~ ^[Nn] ]] && { info "Abgebrochen."; exit 0; }

# ── System-Pakete ─────────────────────────────────────────────────────────────
step "System-Pakete aktualisieren"
run_privileged apt-get update -qq
run_privileged apt-get install -y -qq curl git openssl ca-certificates
ok "Basispakete installiert"

# ── Node.js ───────────────────────────────────────────────────────────────────
step "Node.js ${NODE_VERSION} prüfen/installieren"

if command -v node &>/dev/null; then
    INSTALLED_NODE=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [[ "$INSTALLED_NODE" -ge "$NODE_VERSION" ]]; then
        ok "Node.js $(node --version) bereits installiert"
    else
        warn "Node.js $(node --version) zu alt – aktualisiere auf v${NODE_VERSION}..."
        curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | run_privileged bash -
        run_privileged apt-get install -y nodejs
        ok "Node.js $(node --version) installiert"
    fi
else
    info "Node.js wird installiert..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | run_privileged bash -
    run_privileged apt-get install -y nodejs
    ok "Node.js $(node --version) installiert"
fi

# ── Service-User anlegen ──────────────────────────────────────────────────────
if [[ "$APP_USER" != "root" ]]; then
    step "Service-User '${APP_USER}'"
    if id "$APP_USER" &>/dev/null; then
        ok "User '${APP_USER}' existiert bereits"
    else
        run_privileged useradd --system --shell /bin/false --home-dir "$APP_DIR" --create-home "$APP_USER"
        ok "User '${APP_USER}' angelegt"
    fi
fi

# ── App-Verzeichnis vorbereiten ───────────────────────────────────────────────
step "App-Verzeichnis: ${APP_DIR}"

run_privileged mkdir -p "$APP_DIR"
run_privileged mkdir -p "$APP_DIR/data"
run_privileged mkdir -p "$APP_DIR/storage/invoices"
run_privileged mkdir -p "$APP_DIR/logs"

# ── Code deployen ─────────────────────────────────────────────────────────────
step "Anwendungscode"

if [[ -n "$GIT_REPO" ]]; then
    if [[ -d "$APP_DIR/.git" ]]; then
        info "Repository bereits vorhanden – aktualisiere..."
        run_privileged git -C "$APP_DIR" pull
    else
        run_privileged git clone "$GIT_REPO" "$APP_DIR"
    fi
    ok "Repository geklont/aktualisiert"
else
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [[ "$SCRIPT_DIR" != "$APP_DIR" ]]; then
        info "Kopiere Dateien von ${SCRIPT_DIR} nach ${APP_DIR}..."
        run_privileged rsync -a --exclude='.git' --exclude='node_modules' \
            --exclude='data' --exclude='storage' --exclude='.env' \
            "${SCRIPT_DIR}/" "${APP_DIR}/"
        ok "Dateien kopiert"
    else
        ok "Bereits im App-Verzeichnis"
    fi
fi

# ── npm install ───────────────────────────────────────────────────────────────
step "Node.js Abhängigkeiten installieren"
run_privileged bash -c "cd '${APP_DIR}' && npm install --omit=dev --silent"
ok "npm install abgeschlossen"

# ── Secrets generieren ────────────────────────────────────────────────────────
step "Sicherheits-Secrets generieren"

ADMIN_SECRET=$(openssl rand -hex 48)
HMAC_SECRET=$(openssl rand -hex 48)
PORTAL_SECRET=$(openssl rand -hex 48)
SETUP_TOKEN=$(openssl rand -hex 32)

# RSA Key-Pair für JWT
RSA_PRIVATE=$(openssl genrsa 2048 2>/dev/null)
RSA_PUBLIC=$(echo "$RSA_PRIVATE" | openssl rsa -pubout 2>/dev/null)

# Einzeilig für .env (Zeilenumbrüche → \n)
RSA_PRIVATE_INLINE=$(echo "$RSA_PRIVATE" | awk '{printf "%s\\n", $0}')
RSA_PUBLIC_INLINE=$(echo "$RSA_PUBLIC"  | awk '{printf "%s\\n", $0}')

ok "Secrets generiert (RSA 2048, AES-256)"

# ── .env erstellen ────────────────────────────────────────────────────────────
step ".env Konfigurationsdatei"

run_privileged bash -c "cat > '${APP_DIR}/.env'" <<EOF
# Tafeline License Server – Konfiguration
# Generiert am $(date '+%Y-%m-%d %H:%M:%S')

PORT=${APP_PORT}

DB_PATH=${APP_DIR}/data/licens.db
STORAGE_PATH=${APP_DIR}/storage

ADMIN_SECRET=${ADMIN_SECRET}
HMAC_SECRET=${HMAC_SECRET}
PORTAL_SECRET=${PORTAL_SECRET}

RSA_PRIVATE_KEY=${RSA_PRIVATE_INLINE}
RSA_PUBLIC_KEY=${RSA_PUBLIC_INLINE}

SETUP_TOKEN=${SETUP_TOKEN}

PORTAL_URL=https://${DOMAIN}
APP_URL=https://${DOMAIN}

CORS_ORIGINS=https://${DOMAIN}

# SMTP (optional – über Admin-Panel konfigurierbar)
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=
# SMTP_PASS=
# SMTP_FROM=noreply@${DOMAIN}
EOF

ok ".env erstellt"

# ── Berechtigungen setzen ─────────────────────────────────────────────────────
step "Verzeichnis-Berechtigungen"

if [[ "$APP_USER" == "root" ]]; then
    run_privileged chown -R root:root "$APP_DIR"
    run_privileged chmod 750 "$APP_DIR"
    run_privileged chmod 700 "$APP_DIR/data"
    run_privileged chmod 700 "$APP_DIR/storage"
    run_privileged chmod 600 "$APP_DIR/.env"
else
    run_privileged chown -R "${APP_USER}:${APP_USER}" "$APP_DIR"
    run_privileged chmod 750 "$APP_DIR"
    run_privileged chmod 700 "$APP_DIR/data"
    run_privileged chmod 700 "$APP_DIR/storage"
    run_privileged chmod 600 "$APP_DIR/.env"
    # Logs für eventuelles Log-Forwarding
    run_privileged chmod 755 "$APP_DIR/logs"
fi

ok "Berechtigungen gesetzt"

# ── systemd Service ───────────────────────────────────────────────────────────
step "systemd Service einrichten"

if [[ "$APP_USER" == "root" ]]; then
    SERVICE_USER_LINE=""
    SERVICE_GROUP_LINE=""
else
    SERVICE_USER_LINE="User=${APP_USER}"
    SERVICE_GROUP_LINE="Group=${APP_USER}"
fi

run_privileged bash -c "cat > /etc/systemd/system/licens-srv.service" <<EOF
[Unit]
Description=Tafeline License Server
Documentation=https://github.com/stb-srv/meraki-licens
After=network.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStartPre=/usr/bin/node ${APP_DIR}/init.js
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=licens-srv
${SERVICE_USER_LINE}
${SERVICE_GROUP_LINE}

# Sicherheits-Härtung
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${APP_DIR}/data ${APP_DIR}/storage ${APP_DIR}/logs

# Ressourcen-Limits
LimitNOFILE=65535
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF

run_privileged systemctl daemon-reload
run_privileged systemctl enable licens-srv.service
ok "systemd Service erstellt und aktiviert"

# ── nginx ─────────────────────────────────────────────────────────────────────
if [[ "${SETUP_NGINX^^}" == "J" ]]; then
    step "nginx installieren und konfigurieren"

    run_privileged apt-get install -y -qq nginx

    run_privileged bash -c "cat > /etc/nginx/sites-available/licens-srv" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    # Weiterleitungs-Logs
    access_log /var/log/nginx/licens-srv.access.log;
    error_log  /var/log/nginx/licens-srv.error.log;

    # Sicherheits-Header
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Proxy-Einstellungen
    location / {
        proxy_pass         http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;

        # Upload-Größe
        client_max_body_size 10M;
    }
}
EOF

    # Alte Default-Config deaktivieren
    run_privileged rm -f /etc/nginx/sites-enabled/default
    run_privileged ln -sf /etc/nginx/sites-available/licens-srv /etc/nginx/sites-enabled/licens-srv

    run_privileged nginx -t
    run_privileged systemctl enable nginx
    run_privileged systemctl restart nginx
    ok "nginx konfiguriert"

    # ── Let's Encrypt ──────────────────────────────────────────────────────────
    if [[ "${SETUP_SSL^^}" == "J" && -n "${LE_EMAIL:-}" && "$DOMAIN" != "localhost" ]]; then
        step "Let's Encrypt SSL-Zertifikat"
        run_privileged apt-get install -y -qq certbot python3-certbot-nginx
        run_privileged certbot --nginx \
            --non-interactive \
            --agree-tos \
            --email "$LE_EMAIL" \
            -d "$DOMAIN" \
            --redirect
        ok "SSL-Zertifikat eingerichtet"
    fi
fi

# ── Service starten ───────────────────────────────────────────────────────────
step "License Server starten"
run_privileged systemctl start licens-srv.service

# Kurz warten bis der Server hochgefahren ist
info "Warte auf Server-Start..."
for i in {1..15}; do
    if curl -s "http://127.0.0.1:${APP_PORT}/api/status" &>/dev/null; then
        ok "Server antwortet"
        break
    fi
    sleep 1
    [[ $i -eq 15 ]] && { err "Server startet nicht – prüfe: journalctl -u licens-srv.service -n 50"; exit 1; }
done

# ── Abschluss ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║       Tafeline License Server – Installation fertig!    ║${NC}"
echo -e "${BOLD}${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}${CYAN}▶  Jetzt Setup im Browser abschließen:${NC}"
echo ""
if [[ "${SETUP_SSL^^}" == "J" && "$DOMAIN" != "localhost" ]]; then
    echo -e "     ${BOLD}https://${DOMAIN}/setup${NC}"
else
    echo -e "     ${BOLD}http://${DOMAIN}/setup${NC}"
    echo -e "     ${BOLD}http://localhost:${APP_PORT}/setup${NC}  (lokal)"
fi
echo ""
echo -e "  ${BOLD}Service-Befehle:${NC}"
echo "    systemctl status  licens-srv.service"
echo "    systemctl restart licens-srv.service"
echo "    journalctl -u licens-srv.service -f"
echo ""
echo -e "  ${BOLD}Konfiguration:${NC}  ${APP_DIR}/.env"
echo -e "  ${BOLD}Datenbank:${NC}      ${APP_DIR}/data/licens.db"
echo ""
