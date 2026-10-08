# AGENTS.md — Tafeline License Server

> **Zweck dieser Datei:** Schneller Kontext-Einstieg für KI-Agenten (Copilot, Claude, GPT, Cursor, etc.).  
> Lies diese Datei zuerst, bevor du Code schreibst oder Änderungen vorschlägst.

---

## Projektübersicht

| Eigenschaft         | Wert                                                                 |
|---------------------|----------------------------------------------------------------------|
| **Name**            | Tafeline License Server                                         |
| **Typ**             | REST-API-Lizenzserver (Backend)                                      |
| **Zweck**           | Verwaltung, Validierung und Überwachung von Lizenzen für das [Tafeline Restaurant-CMS](https://github.com/stb-srv/tafeline-cms) |
| **Laufzeitumgebung**| Node.js ≥ 18, MySQL/MariaDB ≥ 10.5                                   |
| **Lizenz**          | MIT                                                                  |
| **Status**          | Production                                                           |
| **Primärsprache**   | JavaScript (ES Modules, `"type": "module"` in package.json)          |
| **Framework**       | Express.js                                                           |
| **Standard-Port**   | `4000`                                                               |

---

## Architektur & Verzeichnisstruktur

```
tafeline-licens/
├── server.js                  # Haupt-Einstiegspunkt – Express-Setup, Middleware, Routen
├── setup-db.js                # Einmaliges DB-Setup & initialen Superadmin erstellen
├── setup-admin.js             # Admin-Account-Setup Hilfsskript
├── deploy.sh                  # Automatisches Deploy-Skript (inkl. PM2, nginx)
├── update.sh                  # In-Place-Update-Skript für Produktionsserver
├── jest.config.js             # Testkonfiguration (Jest mit ESM)
├── .env.example               # Vorlage für alle Umgebungsvariablen
│
├── server/
│   ├── routes/                # Express-Router (aufgeteilt nach Domäne)
│   │   ├── api.js             # Public API  →  /api/v1/
│   │   ├── admin.js           # Admin API   →  /api/admin/
│   │   └── portal.js          # Kunden-Portal → /api/portal/
│   ├── migrations/            # Auto-Migrations (NNNN_beschreibung.js / .sql)
│   ├── mailer/                # E-Mail-Templates & Nodemailer-Wrapper
│   ├── migrate.js             # Migrations-Runner (auch standalone ausführbar)
│   ├── db.js                  # MySQL2-Connection-Pool
│   ├── db-schema.js           # Zentrale Typ-Konstanten für DB-Felder (DB_SCHEMA)
│   ├── middleware.js          # Auth-Middleware (JWT Admin, JWT Portal, Superadmin)
│   ├── cron.js                # Cron-Jobs (Nonces bereinigen, Rechnungen prüfen, Mail-Warnungen)
│   ├── crypto.js              # Krypto-Helfer (RSA, HMAC, Nonce)
│   ├── helpers.js             # Allgemeine Helfer-Funktionen
│   ├── invoiceHelper.js       # Rechnungslogik (Erstellen, Nummernkreis, PDF auslösen)
│   ├── pdfGenerator.js        # PDF-Generierung mit pdfkit
│   ├── smtp.js                # Nodemailer-Transporter-Factory
│   ├── plans.js               # Lizenzplan-Definitionen (TRIAL, FREE, BASIC, PRO, ENTERPRISE)
│   └── webhook.js             # Webhook-Dispatcher für externe Systeme
│
├── public/                    # Statische Assets (Admin-Frontend, wenn vorhanden)
├── coverage/                  # Jest-Coverage-Reports (auto-generiert, nicht committen)
├── tests/                     # Jest-Unit- und Integrationstests
└── Aufgaben/                  # Aufgaben-/Planungsdokumente (Markdown)
```

---

## Kern-Konzepte, die du kennen musst

### 1. Lizenz-Typen (`server/plans.js`)
```
TRIAL | FREE | BASIC | PRO | ENTERPRISE
```
Jeder Typ hat eigene Feature-Flags, Device-Limits und Laufzeiten.  
→ **Niemals** Plan-Logik inline in Routes schreiben; immer `plans.js` erweitern.

### 2. Authentifizierungsschichten

| Schicht            | Token-Typ  | Secret-Variable   | Middleware-Funktion     |
|--------------------|------------|-------------------|-------------------------|
| Admin / Superadmin | JWT HS256  | `ADMIN_SECRET`    | `requireAdmin()`        |
| Superadmin only    | JWT HS256  | `ADMIN_SECRET`    | `requireSuperadmin()`   |
| Kunden-Portal      | JWT HS256  | `PORTAL_SECRET`   | `requirePortalAuth()`   |
| Lizenz-Token       | JWT RS256  | `RSA_PRIVATE_KEY` | (CMS verifiziert lokal) |
| Offline-Token      | HMAC HS256 | `HMAC_SECRET`     | Eigene Validierung      |

### 3. Kryptografie-Strategie
- **Online-Validierung:** Server signiert JWT mit RSA (RS256) → CMS verifiziert lokal via Public Key
- **Offline-Token:** HMAC-signierter Token mit max. 168h Gültigkeit (`/offline-token`)
- **Nonce-System:** Verhindert Token-Replay-Angriffe; abgelaufene Nonces werden via Cron bereinigt
- **2FA:** TOTP (otplib) für Admin-Accounts mit QR-Code-Setup

### 4. Datenbank-Migrationen
- **Automatisch:** Laufen bei jedem `npm start` via `server/migrate.js`
- **Tracking:** Tabelle `schema_migrations` in der DB
- **Naming:** `NNNN_kurze_beschreibung.js` (vierstellige Nummer)
- **Pflicht-Template für neue Migrationen:**
```js
import { DB_SCHEMA } from '../db-schema.js';

export async function up(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS meine_tabelle (
            id          ${DB_SCHEMA.FIELDS.uuid} NOT NULL PRIMARY KEY,
            customer_id ${DB_SCHEMA.PK.customers} NOT NULL,
            name        ${DB_SCHEMA.FIELDS.shortText} NOT NULL,
            created_at  ${DB_SCHEMA.FIELDS.timestamp} DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=${DB_SCHEMA.ENGINE} DEFAULT CHARSET=${DB_SCHEMA.CHARSET};
    `);
}
export default up;
```
> ⚠️ Foreign Keys immer NACH der Tabellenerstellung per `ALTER TABLE` hinzufügen.  
> Referenz-Implementierung: `server/migrations/0017_invoices.js`

### 5. API-Struktur (drei unabhängige Router)

```
/api/v1/       →  server/routes/api.js      (Public – kein Auth)
/api/admin/    →  server/routes/admin.js    (requireAdmin / requireSuperadmin)
/api/portal/   →  server/routes/portal.js   (requirePortalAuth)
```

### 6. Rechnungssystem
- Wird automatisch bei Lizenz-Erstellung/-Verlängerung ausgelöst
- PDFs via `pdfkit` → gespeichert unter `STORAGE_PATH/invoices/`
- Wiederversand über `POST /api/admin/invoices/:id/resend`
- Inkl. `resent_count` Tracking im Audit-Log

### 7. Cron-Jobs (`server/cron.js`)
| Job                     | Aufgabe                                            |
|-------------------------|----------------------------------------------------|
| Nonce-Cleanup           | Abgelaufene Nonces aus DB entfernen                |
| Invoice-Checker         | Fällige/überfällige Rechnungen prüfen & mahnen     |
| License-Expiry-Warning  | E-Mail-Warnung vor Lizenzablauf versenden          |

---

## Wichtige Regeln für Code-Änderungen

1. **ES Modules überall** – `import`/`export`, kein `require()`. Das Projekt nutzt `"type": "module"`.
2. **DB_SCHEMA verwenden** – Niemals Typ-Strings (`CHAR(36)`, `VARCHAR(255)`) hardcoden. Immer `DB_SCHEMA.FIELDS.*` und `DB_SCHEMA.PK.*` aus `server/db-schema.js` nutzen.
3. **Secrets niemals hardcoden** – Alle Secrets kommen aus `.env`. Vorlage: `.env.example`.
4. **Middleware nicht umgehen** – Neue Admin-Routen brauchen `requireAdmin()`, Superadmin-Routen `requireSuperadmin()`.
5. **Audit-Log befüllen** – Sicherheitsrelevante Aktionen (Login, Lizenz-Änderungen, Löschungen) müssen in die `audit_log`-Tabelle geschrieben werden.
6. **Kein direkter DB-Zugriff in Routes** – Datenbanklogik gehört in Helper-Module (`invoiceHelper.js`, `helpers.js`) oder neue Service-Module, nicht in die Route-Handler direkt.
7. **Tests schreiben** – Neue Features brauchen Tests im `tests/`-Verzeichnis. Runner: `npm test` (Jest mit ESM-Support via `--experimental-vm-modules`).

---

## Umgebungsvariablen (Pflichtfelder)

| Variable        | Beschreibung                                                  |
|-----------------|---------------------------------------------------------------|
| `DB_HOST`       | MySQL/MariaDB Host                                            |
| `DB_USER`       | Datenbank-Benutzer                                            |
| `DB_PASS`       | Datenbank-Passwort                                            |
| `DB_NAME`       | Datenbankname                                                 |
| `ADMIN_SECRET`  | JWT-Secret für Admin-Tokens (min. 32 Zeichen, zufällig)       |
| `PORTAL_SECRET` | JWT-Secret für Kunden-Portal-Tokens                           |
| `HMAC_SECRET`   | HMAC-Secret für Offline-Token-Signing                         |

**Empfohlene Generierung:**
```bash
openssl rand -hex 48
```

Optionale aber empfohlene Variablen für Produktion: `RSA_PRIVATE_KEY`, `RSA_PUBLIC_KEY`, `CORS_ORIGINS`, SMTP-Variablen.

---

## Setup & lokale Entwicklung

```bash
# 1. Repository klonen
git clone https://github.com/stb-srv/tafeline-licens
cd tafeline-licens

# 2. Abhängigkeiten installieren
npm install

# 3. Umgebungsvariablen anlegen
cp .env.example .env
# .env anpassen (DB-Credentials, Secrets)

# 4. Server starten (Migrationen laufen automatisch)
npm start

# 5. Tests ausführen
npm test

# 6. Manuell migrieren (optional, z.B. für CI/CD)
node server/migrate.js
```

---

## Deployment (Produktion)

```bash
# Vollständiges Deploy (frische Installation)
bash deploy.sh

# In-Place-Update (laufende Instanz aktualisieren)
bash update.sh
```

Der Server läuft typischerweise hinter einem **nginx Reverse Proxy** auf Ubuntu/Linux, verwaltet durch **PM2**.

---

## Abhängigkeiten (Kurzübersicht)

| Paket                | Zweck                                            |
|----------------------|--------------------------------------------------|
| `express`            | Web-Framework & Routing                          |
| `mysql2`             | MySQL/MariaDB-Treiber (Promise-API)              |
| `jsonwebtoken`       | JWT-Signierung (RS256 für Lizenzen, HS256 sonst) |
| `bcryptjs`           | Passwort-Hashing (Admin & Kunden)                |
| `otplib`             | TOTP-basierte 2FA                                |
| `qrcode`             | QR-Code-Generierung für 2FA-Setup                |
| `pdfkit`             | Rechnungs-PDF-Generierung                        |
| `nodemailer`         | E-Mail-Versand (SMTP)                            |
| `helmet`             | Sicherheits-HTTP-Header                          |
| `cors`               | CORS-Konfiguration                               |
| `express-rate-limit` | Brute-Force-Schutz                               |
| `dotenv`             | Umgebungsvariablen aus `.env`                    |

---

## Sicherheitshinweise für Agenten

- **Niemals** Secrets, RSA-Keys oder Passwörter in Code, Commits oder Logs ausgeben.
- Rate-Limiting ist aktiv auf allen kritischen Endpunkten (`/login`, `/validate`).
- CORS wird dynamisch aus aktiven Lizenzen in der DB abgeglichen, wenn `CORS_ORIGINS` leer ist.
- IP-Whitelisting für Admin-API via `ADMIN_IP_WHITELIST` in `.env` möglich.
- Bei Änderungen an der Auth-Middleware immer beide Pfade prüfen: Token-Ablauf UND fehlende Token.

---

## In Entwicklung (In Progress)

- **Self-Registration:** E-Mail-Verifizierung und Kundenregistrierung (`/trial/register` ist bereits vorbereitet)

---

## Verwandte Projekte

- **Tafeline CMS** (Haupt-Anwendung): [github.com/stb-srv/tafeline-cms](https://github.com/stb-srv/tafeline-cms)
- Der License Server ist eine eigenständige Komponente – er läuft auf einem separaten Server/Port.
