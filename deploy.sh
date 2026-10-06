#!/usr/bin/env bash
# =============================================================================
#  Tafeline License Server – deploy.sh (Update der laufenden Installation)
#
#  Holt den neuesten Stand aus GitHub, sichert vorher Datenbank und .env,
#  installiert Abhängigkeiten, baut das Frontend und startet den Service neu.
#  Schlägt der Start fehl, wird automatisch auf die vorherige Version
#  zurückgerollt. Ist nichts Neues da, passiert nichts (außer mit --force).
#
#  Aufruf (als root oder mit sudo), aus dem Installationsverzeichnis:
#    sudo bash deploy.sh
#
#  Optionen:
#    --branch <name>   Branch deployen (Standard: main)
#    --force           Auch deployen, wenn schon der neueste Stand läuft
#    --no-backup       Kein Backup vor dem Update (nicht empfohlen)
#    -h, --help        Diese Hilfe
# =============================================================================

# Alles steckt in main(): Bash liest Skripte beim Ausführen nach – würde das
# Update dieses Skript selbst ersetzen, könnte sonst mitten im Lauf Unsinn passieren.
main() {
set -Eeuo pipefail

# ── Projektspezifische Werte ─────────────────────────────────────────────────
APP_TITLE="Tafeline License Server"
SERVICE="tafeline-licens"
DEFAULT_PORT="4000"
HEALTH_PATH="/status/json"
DB_DEFAULT="data/licens.db"
EXTRA_BACKUP_FILES=()            # weitere Dateien relativ zum App-Verzeichnis

# ── Ausgabe-Helfer ───────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
info() { echo -e "${CYAN}ℹ${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC}  $*" >&2; }
step() { echo -e "\n${BOLD}${CYAN}▶ $*${NC}"; }
trap 'err "Abbruch in Zeile $LINENO (Befehl: $BASH_COMMAND)"' ERR

SCRIPT="${BASH_SOURCE[0]}"
usage() { awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$SCRIPT"; }

# ── Argumente ────────────────────────────────────────────────────────────────
BRANCH="main"; FORCE="no"; DO_BACKUP="yes"; ORIG_ARGS=("$@")
while [[ $# -gt 0 ]]; do
    case "$1" in
        --branch)    BRANCH="${2:?--branch braucht einen Wert}"; shift 2 ;;
        --force)     FORCE="yes"; shift ;;
        --no-backup) DO_BACKUP="no"; shift ;;
        -h|--help)   usage; exit 0 ;;
        *) err "Unbekannte Option: $1 (siehe --help)"; exit 2 ;;
    esac
done
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { err "Ungültiger Branch: $BRANCH"; exit 1; }

# ── Root ─────────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    command -v sudo >/dev/null || { err "Bitte als root oder mit sudo ausführen."; exit 1; }
    info "Starte neu mit sudo …"
    exec sudo -E bash "$SCRIPT" "${ORIG_ARGS[@]}"
fi

# ── Installation finden ──────────────────────────────────────────────────────
APP_DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"
ENV_FILE="$APP_DIR/.env"
STATE_FILE="$APP_DIR/.deployed-commit"
[[ -d "$APP_DIR/.git" ]] || { err "$APP_DIR ist kein Git-Checkout. Erst setup.sh ausführen."; exit 1; }
[[ -f "$ENV_FILE" ]] || { err "Keine .env in $APP_DIR – erst setup.sh ausführen."; exit 1; }
APP_USER="$(stat -c %U "$APP_DIR")"
[[ "$APP_USER" != "root" ]] || { err "$APP_DIR gehört root – wurde setup.sh ausgeführt?"; exit 1; }
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
as_app() { (cd "$APP_DIR" && runuser -u "$APP_USER" -- env HOME="$APP_HOME" "$@"); }

get_env() { grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true; }
PORT="$(get_env PORT)"; PORT="${PORT:-$DEFAULT_PORT}"

echo -e "\n${BOLD}${CYAN}$APP_TITLE – Deploy${NC}"
echo "  Verzeichnis: $APP_DIR   Service: $SERVICE   Branch: $BRANCH"

# ── 1. Neue Version prüfen ───────────────────────────────────────────────────
step "1/6  Neue Version prüfen"
as_app git fetch --quiet origin "$BRANCH"
OLD_SHA="$(as_app git rev-parse HEAD)"
NEW_SHA="$(as_app git rev-parse "origin/$BRANCH")"
DEPLOYED_SHA="$(cat "$STATE_FILE" 2>/dev/null || true)"
if [[ "$NEW_SHA" == "$DEPLOYED_SHA" && "$FORCE" == "no" ]]; then
    ok "Bereits aktuell (${NEW_SHA:0:7}). Mit --force trotzdem neu deployen."
    exit 0
fi
info "${OLD_SHA:0:7} → ${NEW_SHA:0:7}"

# ── 2. Backup ────────────────────────────────────────────────────────────────
step "2/6  Backup"
BACKUP_ROOT="$APP_DIR/deploy-backups"
BACKUP_DIR="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
if [[ "$DO_BACKUP" == "yes" ]]; then
    mkdir -p "$BACKUP_DIR"
    chown "$APP_USER:$APP_USER" "$BACKUP_ROOT" "$BACKUP_DIR"
    DB_PATH_VALUE="$(get_env DB_PATH)"; DB_PATH_VALUE="${DB_PATH_VALUE:-$DB_DEFAULT}"
    [[ "$DB_PATH_VALUE" = /* ]] && DB_FILE="$DB_PATH_VALUE" || DB_FILE="$APP_DIR/$DB_PATH_VALUE"
    if [[ -f "$DB_FILE" ]]; then
        # SQLite-Online-Backup (konsistent, auch bei laufendem Service)
        if ! as_app node -e '
            const Database = require("better-sqlite3");
            const db = new Database(process.argv[1], { readonly: true });
            db.backup(process.argv[2]).then(() => db.close()).catch((e) => { console.error(e.message); process.exit(1); });
        ' "$DB_FILE" "$BACKUP_DIR/$(basename "$DB_FILE")" 2>/dev/null; then
            cp -a "$DB_FILE" "$BACKUP_DIR/"
            warn "Online-Backup nicht möglich – Datei kopiert"
        fi
        ok "Datenbank gesichert"
    else
        info "Noch keine Datenbank ($DB_FILE) – nichts zu sichern"
    fi
    cp -a "$ENV_FILE" "$BACKUP_DIR/.env"
    for f in "${EXTRA_BACKUP_FILES[@]}"; do [[ -f "$APP_DIR/$f" ]] && cp -a "$APP_DIR/$f" "$BACKUP_DIR/"; done
    # Lokale Änderungen an versionierten Dateien würden überschrieben – vorher sichern
    if [[ -n "$(as_app git status --porcelain --untracked-files=no)" ]]; then
        as_app git diff HEAD > "$BACKUP_DIR/local-changes.patch" || true
        warn "Lokale Code-Änderungen werden überschrieben (Sicherung: $BACKUP_DIR/local-changes.patch)"
    fi
    chmod -R go-rwx "$BACKUP_DIR"
    chown -R "$APP_USER:$APP_USER" "$BACKUP_ROOT"
    # Nur die letzten 10 Backups behalten
    ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf
    ok "Backup in $BACKUP_DIR"
else
    warn "Backup übersprungen (--no-backup)"
fi

# ── Update-/Rollback-Funktionen ──────────────────────────────────────────────
# Kein "set -e"-Schutz, wenn per "||" aufgerufen – daher explizit "|| return 1"
install_and_build() {
    as_app npm ci --omit=dev --no-audit --no-fund --loglevel=error || return 1
    as_app npm --prefix web ci --no-audit --no-fund --loglevel=error || return 1
    as_app npm --prefix web run build --silent || return 1
}
wait_healthy() {
    local i
    for i in $(seq 1 30); do
        curl -fs -o /dev/null "http://127.0.0.1:$PORT$HEALTH_PATH" && return 0
        sleep 2
    done
    return 1
}

# ── 3. Update ────────────────────────────────────────────────────────────────
step "3/6  Service stoppen & Code aktualisieren"
systemctl stop "$SERVICE" 2>/dev/null || true
as_app git checkout --quiet --force -B "$BRANCH" "origin/$BRANCH"
ok "Code auf ${NEW_SHA:0:7}"

step "4/6  Abhängigkeiten & Frontend (dauert ein paar Minuten)"
FAILED="no"
install_and_build || FAILED="yes"

step "5/6  Service starten"
if [[ "$FAILED" == "no" ]]; then
    systemctl start "$SERVICE"
    wait_healthy || FAILED="yes"
fi

# ── Rollback bei Fehler ──────────────────────────────────────────────────────
if [[ "$FAILED" == "yes" ]]; then
    err "Update fehlgeschlagen. Letzte Logzeilen:"
    journalctl -u "$SERVICE" -n 25 --no-pager || true
    warn "Rolle auf ${OLD_SHA:0:7} zurück …"
    systemctl stop "$SERVICE" 2>/dev/null || true
    as_app git checkout --quiet --force -B "$BRANCH" "$OLD_SHA"
    install_and_build || true
    systemctl start "$SERVICE"
    if wait_healthy; then
        warn "Alte Version läuft wieder. Fehler beheben und deploy.sh erneut ausführen."
    else
        err "Auch die alte Version startet nicht – bitte Logs prüfen: journalctl -u $SERVICE -n 100"
    fi
    [[ "$DO_BACKUP" == "yes" ]] && warn "Falls Migrationen gelaufen sind: Datenbank-Backup liegt in $BACKUP_DIR"
    exit 1
fi

# ── 6. Abschluss ─────────────────────────────────────────────────────────────
step "6/6  Abschluss"
echo "$NEW_SHA" > "$STATE_FILE"
chown "$APP_USER:$APP_USER" "$STATE_FILE"
ok "Server läuft und antwortet auf $HEALTH_PATH"
if [[ "$OLD_SHA" != "$NEW_SHA" ]]; then
    echo -e "\n${BOLD}Änderungen:${NC}"
    as_app git log --oneline --no-decorate "$OLD_SHA..$NEW_SHA" 2>/dev/null | head -n 15 | sed 's/^/  /' || true
fi
echo -e "\n${BOLD}${GREEN}✅ Update auf ${NEW_SHA:0:7} abgeschlossen.${NC}\n"
echo "  Logs:    journalctl -fu $SERVICE"
echo "  Status:  systemctl status $SERVICE"
echo ""
}

main "$@"; exit $?
