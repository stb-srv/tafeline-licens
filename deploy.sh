#!/bin/bash
set -e

# ============================================================
#  Tafeline — License Server Deploy Script v2.1
#  Ubuntu 22.04 / 24.04 / 25.04 | Als root oder mit sudo
#  Nutzung: bash deploy.sh
# ============================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

APP_DIR="/opt/licens-srv"
APP_USER="licens-srv"
GITHUB_REPO="stb-srv/tafeline-licens"
SERVICE_NAME="licens-srv"
PORT=4000

echo -e ""
echo -e "${BOLD}${CYAN}🏛️  Tafeline — License Server Deploy v2.1${NC}"
echo -e "${CYAN}$(printf '═%.0s' {1..55})${NC}\n"

# ── Root-Check ─────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}✗ Bitte als root oder mit sudo ausführen!${NC}"
    exit 1
fi

# ── GitHub Token abfragen ────────────────────────────────────────────────
echo -e "${BOLD}[0/8] GitHub Authentifizierung...${NC}"

# Prüfen ob Token bereits als Umgebungsvariable gesetzt
if [ -n "$GITHUB_TOKEN" ]; then
    echo -e "  ${GREEN}✓ GitHub Token aus Umgebungsvariable gelesen${NC}"
else
    echo -e "  ${CYAN}Das Repository ist privat – GitHub Personal Access Token benötigt.${NC}"
    echo -e "  ${CYAN}Token erstellen: https://github.com/settings/tokens${NC}"
    echo -e "  ${CYAN}Benötigte Berechtigung: ${BOLD}repo${NC} (read)${NC}"
    echo ""
    read -s -p "  GitHub Token eingeben: " GITHUB_TOKEN
    echo ""
    if [ -z "$GITHUB_TOKEN" ]; then
        echo -e "  ${RED}✗ Kein Token eingegeben – Abbruch.${NC}"
        exit 1
    fi
fi

# Token validieren
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: token $GITHUB_TOKEN" \
    "https://api.github.com/repos/$GITHUB_REPO")

if [ "$HTTP_STATUS" != "200" ]; then
    echo -e "  ${RED}✗ Token ungültig oder kein Zugriff auf das Repository (HTTP $HTTP_STATUS)${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓ Token gültig – Zugriff auf Repository bestätigt${NC}"

# Repo-URL mit Token (wird nur intern genutzt, nie geloggt)
REPO="https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"

# ── 1. System-Pakete & Node.js 22 ─────────────────────────────────────────
echo -e "\n${BOLD}[1/8] System updaten & Node.js 22 installieren...${NC}"
apt-get update -qq
apt-get install -y -qq curl git openssl

if ! command -v node &>/dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - &>/dev/null
    apt-get install -y -qq nodejs
fi
echo -e "  ${GREEN}✓ Node.js $(node -v) bereit${NC}"

# ── 2. App-User ─────────────────────────────────────────────────────────────
echo -e "\n${BOLD}[2/8] App-User '${APP_USER}' prüfen...${NC}"
if ! id "$APP_USER" &>/dev/null; then
    useradd --system --shell /bin/bash --create-home "$APP_USER"
    echo -e "  ${GREEN}✓ User erstellt${NC}"
else
    echo -e "  ${GREEN}✓ User existiert bereits${NC}"
fi

# ── 3. Repo klonen / updaten (Token-Auth, konfliktfrei) ─────────────────────
echo -e "\n${BOLD}[3/8] Repository klonen / updaten...${NC}"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

if [ -d "$APP_DIR/.git" ]; then
    chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
    cd "$APP_DIR"
    # Remote-URL mit aktuellem Token aktualisieren (falls Token sich geändert hat)
    git remote set-url origin "$REPO"
    # Konfliktfrei updaten – kein stash, kein merge, kein Abort
    git fetch origin main
    git reset --hard origin/main
    echo -e "  ${GREEN}✓ Repository aktualisiert${NC}"
else
    git clone "$REPO" "$APP_DIR"
    chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
    echo -e "  ${GREEN}✓ Repository geklont${NC}"
fi

# Token aus Remote-URL entfernen (Sicherheit – nicht in .git/config speichern)
cd "$APP_DIR"
git remote set-url origin "https://github.com/${GITHUB_REPO}.git"
echo -e "  ${GREEN}✓ Token aus Git-Config entfernt${NC}"

# ── 4. .env generieren (nur wenn noch nicht vorhanden) ──────────────────────
echo -e "\n${BOLD}[4/8] .env konfigurieren & Secrets generieren...${NC}"

if [ ! -f "$APP_DIR/.env" ]; then
    echo -e "  ${CYAN}→ Generiere kryptografische Secrets...${NC}"

    ADMIN_SECRET=$(openssl rand -hex 48)
    HMAC_SECRET=$(openssl rand -hex 48)
    WEBHOOK_SECRET=$(openssl rand -hex 24)

    # RSA-2048 Schlüsselpaar generieren
    echo -e "  ${CYAN}→ Generiere RSA-2048 Schlüsselpaar...${NC}"
    TEMP_KEY=$(mktemp)
    TEMP_PUB=$(mktemp)
    openssl genrsa -out "$TEMP_KEY" 2048 2>/dev/null
    openssl rsa -in "$TEMP_KEY" -pubout -out "$TEMP_PUB" 2>/dev/null

    # Private Key für .env inline (Newlines als \n)
    RSA_PRIVATE_KEY_INLINE=$(awk 'NF {printf "%s\\n", $0}' "$TEMP_KEY" | sed 's/\\n$//')

    # Keys als Dateien ablegen
    cp "$TEMP_PUB" "$APP_DIR/public.pem"
    cp "$TEMP_KEY" "$APP_DIR/private.pem"
    chown "$APP_USER":"$APP_USER" "$APP_DIR/public.pem" "$APP_DIR/private.pem"
    chmod 644 "$APP_DIR/public.pem"
    chmod 600 "$APP_DIR/private.pem"
    rm -f "$TEMP_KEY" "$TEMP_PUB"

    # DB-Passwort abfragen
    echo ""
    echo -e "  ${BOLD}MySQL Zugangsdaten für Netcup:${NC}"
    echo -e "  ${CYAN}  Host: mysql2ebc.netcup.net | DB: k220163_opa | User: k220163_opa${NC}"
    echo ""
    read -s -p "  MySQL Passwort eingeben: " DB_PASS_INPUT
    echo ""
    if [ -z "$DB_PASS_INPUT" ]; then
        echo -e "  ${YELLOW}⚠️  Kein Passwort eingegeben – bitte später in .env nachtragen!${NC}"
        DB_PASS_INPUT="BITTE_DB_PASSWORT_EINTRAGEN"
    else
        echo -e "  ${GREEN}✓ DB-Passwort gesetzt${NC}"
    fi

    # .env schreiben
    cat > "$APP_DIR/.env" <<EOF
PORT=${PORT}

# Admin JWT Secret (automatisch generiert)
ADMIN_SECRET=${ADMIN_SECRET}

# HMAC Signing Secret (automatisch generiert)
HMAC_SECRET=${HMAC_SECRET}

# RSA-2048 Private Key fuer signierte License Tokens (RS256)
RSA_PRIVATE_KEY="${RSA_PRIVATE_KEY_INLINE}"

# MySQL Datenbank (Netcup)
DB_HOST=mysql2ebc.netcup.net
DB_PORT=3306
DB_NAME=k220163_opa
DB_USER=k220163_opa
DB_PASS=${DB_PASS_INPUT}

# CORS: erlaubte Origins (kommagetrennt, leer = alle erlaubt)
CORS_ORIGINS=

# SMTP Konfiguration (optional, kann auch im Admin-Panel gesetzt werden)
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

# Webhook (optional)
WEBHOOK_URL=
WEBHOOK_SECRET=${WEBHOOK_SECRET}
EOF

    chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"

    echo -e "  ${GREEN}✓ .env mit allen Secrets erstellt${NC}"
    echo -e "  ${GREEN}✓ RSA Private Key: $APP_DIR/private.pem${NC}"
    echo -e "  ${GREEN}✓ RSA Public Key:  $APP_DIR/public.pem ${CYAN}(für CMS)${NC}"
else
    echo -e "  ${GREEN}✓ .env existiert bereits – wird nicht überschrieben${NC}"
fi

# ── 5. npm install ─────────────────────────────────────────────────────────────
echo -e "\n${BOLD}[5/8] Dependencies installieren...${NC}"
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev --silent
echo -e "  ${GREEN}✓ Dependencies installiert${NC}"

# ── 6. Datenbank-Schema + Migration ──────────────────────────────────────────
echo -e "\n${BOLD}[6/8] Datenbank-Schema & Migration...${NC}"
cd "$APP_DIR"
sudo -u "$APP_USER" node migrate.js

# ── 7. Systemd Service ─────────────────────────────────────────────────────────
echo -e "\n${BOLD}[7/8] Systemd Service einrichten...${NC}"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Tafeline License Server
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo -e "  ${GREEN}✓ Service läuft & Autostart aktiviert${NC}"
else
    echo -e "  ${RED}✗ Service hat möglicherweise einen Fehler:${NC}"
    journalctl -u "$SERVICE_NAME" -n 20 --no-pager
fi

# ── 8. Zusammenfassung ─────────────────────────────────────────────────────────
echo -e "\n${BOLD}[8/8] Abschluss...${NC}"
echo -e "  ${CYAN}→ Admin wird durch migrate.js erstellt (admin / admin123)${NC}"
echo -e "  ${RED}❗ Bitte sofort Admin-Passwort ändern!${NC}"

echo ""
echo -e "${CYAN}$(printf '═%.0s' {1..55})${NC}"
echo -e "${GREEN}${BOLD}✅ Deploy abgeschlossen!${NC}"
echo ""
echo -e "  🏛️  Server läuft auf Port:    ${YELLOW}${PORT}${NC}"
echo -e "  🔑 RSA Public Key für CMS: ${YELLOW}cat $APP_DIR/public.pem${NC}"
echo -e "  📝 Logs:                     ${YELLOW}journalctl -fu ${SERVICE_NAME}${NC}"
echo -e "  📊 Status:                   ${YELLOW}systemctl status ${SERVICE_NAME}${NC}"
echo ""
echo -e "  ${BOLD}${YELLOW}Nächste Schritte:${NC}"
echo -e "  ${YELLOW}1. Firewall:           ufw allow ${PORT}${NC}"
echo -e "  ${YELLOW}2. Admin-Passwort ändern (Standard: admin / admin123)${NC}"
echo -e "  ${YELLOW}3. CMS Public Key:     cat $APP_DIR/public.pem${NC}"
echo -e "  ${YELLOW}4. CORS in .env:       nano $APP_DIR/.env${NC}"
echo ""
