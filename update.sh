#!/bin/bash
# ============================================================
# Tafeline License Server — Auto-Update Script
# ============================================================
# Dieses Script:
#  1. Erstellt ein Backup der db.json + .env (falls vorhanden)
#  2. Holt die neueste Version von GitHub (überschreibt lokale Änderungen)
#  3. Stellt .env wieder her (wird nie überschrieben)
#  4. Installiert neue Dependencies
#  5. Führt die Migration durch
#  6. Startet den Server neu (pm2 oder systemd)
#
# Nutzung:
#   bash update.sh
# ============================================================

set -e

# Farben
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
BOLD="\033[1m"
NC="\033[0m"

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
PM2_APP_NAME="tafeline-licens"
SYSTEMD_SERVICE="licens-srv"

echo ""
echo -e "${BOLD}${CYAN}🏛️  Tafeline License Server — Update Script${NC}"
echo -e "${CYAN}$(printf '═%.0s' {1..55})${NC}"
echo -e "${CYAN}📁 Projektverzeichnis: $PROJECT_DIR${NC}"
echo ""

# ── Schritt 1: Backup erstellen ───────────────────────────────────────────────
echo -e "${BOLD}📦 Schritt 1/6: Backup erstellen...${NC}"
mkdir -p "$BACKUP_DIR"

# db.json sichern (Legacy – falls noch vorhanden)
if [ -f "$PROJECT_DIR/db.json" ]; then
    cp "$PROJECT_DIR/db.json" "$BACKUP_DIR/db_$TIMESTAMP.json"
    echo -e "  ${GREEN}✓ db.json gesichert → backups/db_$TIMESTAMP.json${NC}"
fi

# .env sichern – wird nach dem Reset wiederhergestellt
if [ -f "$PROJECT_DIR/.env" ]; then
    cp "$PROJECT_DIR/.env" "$BACKUP_DIR/env_$TIMESTAMP.bak"
    echo -e "  ${GREEN}✓ .env gesichert → backups/env_$TIMESTAMP.bak${NC}"
else
    echo -e "  ${YELLOW}⚠️  Keine .env gefunden – bitte nach dem Update befüllen!${NC}"
fi

# Alte Backups aufräumen (nur die letzten 10 behalten)
cd "$BACKUP_DIR"
ls -t db_*.json  2>/dev/null | tail -n +11 | xargs -r rm --
ls -t env_*.bak  2>/dev/null | tail -n +11 | xargs -r rm --
echo -e "  ${GREEN}✓ Backups bereinigt (max. 10 je Typ)${NC}"
cd "$PROJECT_DIR"

# ── Schritt 2: GitHub – fetch + hard reset ────────────────────────────────────
# Kein stash, kein merge, kein Konflikt:
# git fetch holt den aktuellen Stand, reset --hard übernimmt ihn 1:1.
# Lokale Änderungen an versionierten Dateien werden ÜBERSCHRIEBEN.
# Die .env ist nicht versioniert und bleibt unberührt.
echo -e "\n${BOLD}📥 Schritt 2/6: Neueste Version von GitHub holen...${NC}"
cd "$PROJECT_DIR"

CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo 'unbekannt')

git fetch origin main
git reset --hard origin/main

NEW_SHA=$(git rev-parse HEAD 2>/dev/null || echo 'unbekannt')

if [ "$CURRENT_SHA" = "$NEW_SHA" ]; then
    echo -e "  ${YELLOW}⚠️  Bereits auf dem neuesten Stand ($NEW_SHA)${NC}"
else
    echo -e "  ${GREEN}✓ Update: ${CURRENT_SHA:0:7} → ${NEW_SHA:0:7}${NC}"
fi

# .env wiederherstellen falls sie durch reset verloren gegangen wäre
# (passiert nicht da .env in .gitignore ist, aber sicher ist sicher)
if [ ! -f "$PROJECT_DIR/.env" ] && [ -f "$BACKUP_DIR/env_$TIMESTAMP.bak" ]; then
    cp "$BACKUP_DIR/env_$TIMESTAMP.bak" "$PROJECT_DIR/.env"
    echo -e "  ${GREEN}✓ .env wiederhergestellt${NC}"
fi

# ── Schritt 3: node_modules aufräumen falls package.json geändert ─────────────
echo -e "\n${BOLD}📦 Schritt 3/6: Dependencies installieren...${NC}"
cd "$PROJECT_DIR"

# Prüfen ob sich package.json geändert hat
if [ "$CURRENT_SHA" != "$NEW_SHA" ]; then
    PKGJSON_CHANGED=$(git diff "$CURRENT_SHA" "$NEW_SHA" --name-only 2>/dev/null | grep -c 'package.json' || true)
    if [ "$PKGJSON_CHANGED" -gt 0 ]; then
        echo -e "  ${YELLOW}→ package.json geändert – führe npm ci aus${NC}"
        npm ci --omit=dev --silent
    else
        echo -e "  ${CYAN}→ package.json unverändert – npm install${NC}"
        npm install --omit=dev --silent
    fi
else
    npm install --omit=dev --silent
fi
echo -e "  ${GREEN}✓ Dependencies aktuell${NC}"

# ── Schritt 4: Server stoppen (vor Migration) ─────────────────────────────────
echo -e "\n${BOLD}⏸️  Schritt 4/6: Server kurz stoppen...${NC}"
cd "$PROJECT_DIR"

if command -v pm2 &>/dev/null && pm2 describe "$PM2_APP_NAME" &>/dev/null; then
    pm2 stop "$PM2_APP_NAME" --silent
    echo -e "  ${GREEN}✓ PM2: '$PM2_APP_NAME' gestoppt${NC}"
elif systemctl is-active --quiet "$SYSTEMD_SERVICE" 2>/dev/null; then
    systemctl stop "$SYSTEMD_SERVICE"
    echo -e "  ${GREEN}✓ systemd: '$SYSTEMD_SERVICE' gestoppt${NC}"
else
    echo -e "  ${CYAN}→ Kein laufender Prozess gefunden – weiter${NC}"
fi

# ── Schritt 5: Migration durchführen ──────────────────────────────────────────
echo -e "\n${BOLD}🔄 Schritt 5/6: Daten migrieren...${NC}"
cd "$PROJECT_DIR"
node server/migrate.js

# ── Schritt 6: Server neu starten ─────────────────────────────────────────────
echo -e "\n${BOLD}🚀 Schritt 6/6: Server neu starten...${NC}"
cd "$PROJECT_DIR"

if command -v pm2 &>/dev/null; then
    if pm2 describe "$PM2_APP_NAME" &>/dev/null; then
        pm2 start "$PM2_APP_NAME" --silent
        echo -e "  ${GREEN}✓ PM2: '$PM2_APP_NAME' gestartet${NC}"
    else
        pm2 start server.js --name "$PM2_APP_NAME"
        echo -e "  ${GREEN}✓ PM2: '$PM2_APP_NAME' neu registriert und gestartet${NC}"
    fi
    pm2 save --silent
elif systemctl list-unit-files --type=service 2>/dev/null | grep -q "^$SYSTEMD_SERVICE\.service"; then
    systemctl restart "$SYSTEMD_SERVICE"
    echo -e "  ${GREEN}✓ systemd: '$SYSTEMD_SERVICE' neu gestartet${NC}"
else
    echo -e "  ${YELLOW}⚠️  Kein PM2/systemd gefunden – bitte manuell starten:${NC}"
    echo -e "  ${CYAN}     npm start${NC}"
fi

echo ""
echo -e "${CYAN}$(printf '═%.0s' {1..55})${NC}"
echo -e "${GREEN}${BOLD}✅ Update abgeschlossen! Tafeline License Server läuft.${NC}"
echo -e "${CYAN}   Backup in:  $BACKUP_DIR${NC}"
echo -e "${CYAN}   Version:    ${NEW_SHA:0:7}${NC}"
echo ""
