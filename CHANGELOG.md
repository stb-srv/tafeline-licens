# Changelog

Alle wesentlichen Änderungen an diesem Projekt werden hier dokumentiert.
Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/).

---

## [Unreleased]

### Fixed

- 2FA (TOTP) funktionierte seit dem Update auf otplib 13 nicht mehr (`authenticator` existiert dort nicht); Login, Einrichtung und Bestätigung nutzen jetzt die neue API über `server/totp.js`.

### Added

- Backups werden nach dem Erstellen geprüft (integrity_check, Kerntabellen); defekte Backups werden verworfen.
- Optionale zweite Backup-Kopie (`BACKUP_COPY_DIR`) und Betriebs-Alarme per E-Mail/Webhook (`ALERT_EMAIL`, `ALERT_WEBHOOK_URL`) bei fehlgeschlagenem Backup.

### Changed

- Abhängigkeiten aktualisiert (Express 5, bcryptjs 3, express-rate-limit 8, dotenv, pdfkit, nodemailer, pino, Astro, ESLint 10); `npm audit` meldet 0 Schwachstellen.
- ESLint-Konfiguration repariert (Browser-Globals für `web/src`), Code mit Prettier formatiert.
- CI führt jetzt Lint, Format-Check, Tests, Audit und den Web-Build aus.

### Security

- **SEC-03**: `SETUP_TOKEN` als Pflicht-Env-Variable für den Setup-Endpoint einführen
  (`POST /api/v1/setup` darf nur mit gültigem Token ausgeführt werden).
  _Status: `.env.example` dokumentiert – Prüfung im `server.js` muss noch implementiert werden._
- **SEC-05**: `node_modules` müssen aus Git-History entfernt werden
  (`git rm -r --cached node_modules && git commit`).
  _Status: `.gitignore` ist korrekt – manueller History-Cleanup erforderlich._

### Improvements

- **IMP-03**: CORS-Origin In-Memory-Cache geplant
  (aktuell DB-Query bei JEDEM Request – 5-Min-TTL-Map reduziert DB-Last drastisch).
- **IMP-05**: Docker Compose für License-Server + MySQL geplant.
- **IMP-06**: Trial-Lizenz-Registrierung beim License-Server oder Reset-Limit geplant.
- **NTH-04**: Formales Migrations-Tool (Knex o.ä.) geplant.
- **NTH-05**: Webhook-Retry-Mechanismus geplant (aktuell nur 1 Versuch, 5s Timeout).

---

## [1.0.0] – 2026-04-12

### Hinzugefügt

- License Server als Node.js/Express-Monolith mit RS256-JWT-Token-Austellung
- MySQL-Datenbank mit Lizenz-, Kunden-, Geräte- und Audit-Log-Tabellen
- Rate Limiting auf Login (10/15min), Validation (30/min), Reservierungen (20/15min)
- Nonce-Replay-Schutz auf `/api/v1/validate`
- HMAC-Signierung aller API-Responses (`_sig` + `_ts`)
- Expiry-Cron mit automatischer E-Mail-Warnung 30 Tage vor Ablauf
- Offline-Token (bis 168h, HMAC-gesichert)
- Device-Tracking mit `max_devices`-Limit
- Admin-Dashboard (REST-API mit JWT-Auth)
- Webhook-System für Lizenz-Statusänderungen
- Deploy-Skripte für Ubuntu (`deploy.sh`, `install-ubuntu.sh`)
