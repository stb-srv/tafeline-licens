# Tafeline License Server

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-339933?logo=node.js&logoColor=white)
![SQLite](https://img.shields.io/badge/Database-SQLite-003B57?logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)
![Status](https://img.shields.io/badge/Status-Production-success)

Zentraler REST-API-Lizenzserver für das [Tafeline Restaurant-Management-System (CMS)](https://github.com/stb-srv/tafeline-cms). Verwaltet, validiert und überwacht Lizenzen für registrierte CMS-Instanzen – mit signierten kryptografischen Tokens für sichere Echtzeit-Validierungen und zeitlich begrenzte Offline-Freischaltungen.

---

## Schnellstart (Produktion)

### Einzeiler-Setup auf Ubuntu/Debian

```bash
git clone https://github.com/stb-srv/tafeline-licens
cd tafeline-licens
bash setup.sh
```

Das Script installiert Node.js, nginx und richtet den systemd-Service ein. Es fragt nur nach Domain, Port und SSL. **Alle kryptografischen Secrets werden automatisch generiert.** Den Admin-Account erstellst du danach im Browser – kein manuelles Bearbeiten von Konfigurationsdateien nötig.

### Lokal / ohne setup.sh

```bash
git clone https://github.com/stb-srv/tafeline-licens
cd tafeline-licens
npm install
npm start
```

`npm start` erkennt beim ersten Start automatisch, dass keine `.env` vorhanden ist, generiert alle Secrets und zeigt die Setup-URL:

```
  ╔══════════════════════════════════════════════════════╗
  ║   Tafeline License Server – Ersteinrichtung           ║
  ╚══════════════════════════════════════════════════════╝

  ✓  .env erstellt – alle Secrets automatisch generiert

  Setup jetzt im Browser abschließen:

    → http://localhost:4000/setup
```

Öffne die URL, lege Benutzernamen und Passwort für den Superadmin-Account fest – fertig.

---

## Was automatisch passiert

| Schritt                                        | Automatisch               |
| ---------------------------------------------- | ------------------------- |
| `.env` erstellen                               | ✅                        |
| `ADMIN_SECRET` generieren                      | ✅                        |
| `HMAC_SECRET` generieren (Offline-Tokens)      | ✅                        |
| `PORTAL_SECRET` generieren (Kunden-Portal JWT) | ✅                        |
| RSA-Schlüsselpaar generieren (2048-bit)        | ✅                        |
| Datenbank-Migrationen ausführen                | ✅                        |
| Admin-Account erstellen                        | Im Browser unter `/setup` |
| SMTP / Domain konfigurieren                    | Im Admin-Panel            |

---

## Features

- **Lizenzverwaltung & Validierung** — Key-Management mit Typen (TRIAL, FREE, BASIC, PRO, ENTERPRISE), Domain-Binding mit Wildcard-Support
- **Kunden-Portal** — Dedizierter Bereich zur Profilverwaltung, Domain-Zuweisung und Rechnungsdownload
- **Automatisches Rechnungssystem** — PDF-Generierung via `pdfkit`, Mahnwesen-Cronjob, konfigurierbares Design
- **Reseller-System** — Automatisierte Lizenzbestellung über verschlüsselte API-Keys
- **Zwei-Faktor-Authentifizierung (2FA)** — TOTP via Authenticator-App für alle Admin-Accounts
- **Webhooks & Audit-Log** — Event-getriebene Notifications an Drittsysteme + vollständiges Audit-Protokoll
- **Trial Self-Registration** — Kunden registrieren 30-Tage-Trials direkt aus dem CMS heraus
- **Auto-Migration** — Schema-Migrationen laufen automatisch beim Serverstart

---

## Voraussetzungen

- **Node.js** >= 18.x
- **Kein Datenbankserver nötig** — SQLite ist integriert
- Ubuntu 22.04 / 24.04 oder Debian 12 (für `setup.sh`)

---

## Umgebungsvariablen (`.env`)

Die `.env` wird beim ersten `npm start` **automatisch mit sicheren Zufallswerten erstellt**. Optionale Parameter kannst du danach anpassen.

| Variable             | Pflicht   | Beschreibung                                              |
| -------------------- | --------- | --------------------------------------------------------- |
| `PORT`               | Nein      | HTTP-Port (Standard: `4000`)                              |
| `DB_PATH`            | Nein      | SQLite-Datenbankpfad (Standard: `./data/licens.db`)       |
| `STORAGE_PATH`       | Nein      | PDF-Speicherpfad (Standard: `./storage`)                  |
| `ADMIN_SECRET`       | **Ja**    | JWT-Secret für Admin-Sessions                             |
| `HMAC_SECRET`        | **Ja**    | Secret für HMAC-Offline-Tokens (min. 32 Zeichen)          |
| `PORTAL_SECRET`      | **Ja**    | JWT-Secret für Kunden-Portal-Sessions                     |
| `RSA_PRIVATE_KEY`    | Empfohlen | PEM-Privatschlüssel für RS256 Lizenz-Tokens               |
| `RSA_PUBLIC_KEY`     | Empfohlen | PEM-Öffentlicher Schlüssel für CMS-seitige Verifikation   |
| `SETUP_TOKEN`        | Einmalig  | Token für Ersteinrichtung (nach Setup irrelevant)         |
| `CORS_ORIGINS`       | Nein      | Erlaubte Origins, kommagetrennt (leer = dynamisch aus DB) |
| `ADMIN_IP_WHITELIST` | Nein      | Erlaubte IPs für Admin-Zugriff, kommagetrennt             |
| `PORTAL_URL`         | Nein      | Basis-URL für Portal-Links in E-Mails                     |
| `APP_URL`            | Nein      | App-URL für E-Mail-Links                                  |
| `SMTP_HOST`          | Nein      | SMTP-Server (alternativ über Admin-Panel konfigurierbar)  |
| `SMTP_PORT`          | Nein      | SMTP-Port (Standard: `587`)                               |
| `SMTP_USER`          | Nein      | SMTP-Benutzername                                         |
| `SMTP_PASS`          | Nein      | SMTP-Passwort                                             |
| `SMTP_FROM`          | Nein      | Absender-Adresse                                          |

---

## Frontend (Astro)

Das Frontend ist in Astro gebaut und produziert einen statischen Build unter `web/dist/`, den Express automatisch serviert.

### Architektur

```
web/src/
├── components/
│   ├── Header.astro       ← zentrale Nav-Leiste für alle Seiten
│   ├── Footer.astro       ← zentrale Fußzeile für alle Seiten
│   └── ThemeToggle.astro
├── layouts/
│   ├── BaseLayout.astro   ← HTML-Shell (head, fonts, FOUC-Guard, tokens)
│   ├── AppLayout.astro    ← BaseLayout + Header + Footer (für neue Seiten)
│   └── AdminLayout.astro  ← BaseLayout + Auth-Guard
├── pages/
│   ├── index.astro        ← Admin-Panel (SPA)
│   ├── portal.astro       ← Kunden-Portal (SPA)
│   ├── login.astro        ← Login (Admin + Kunde)
│   └── setup.astro        ← Ersteinrichtungs-Wizard
└── styles/
    ├── tokens.css         ← Design-Tokens (Farben, Spacing, Typografie)
    └── global.css         ← Globale Styles (Buttons, nav, footer, Icons)
```

### Zentrale Änderungen — einmal ändern, überall wirksam

| Was ändern                            | Datei                                      |
| ------------------------------------- | ------------------------------------------ |
| Logo-Bild / Logo-Link                 | `web/src/components/Header.astro`          |
| Nav-Styling (Hintergrund, Höhe, Blur) | `web/src/styles/global.css` → `nav { }`    |
| Footer-Copyright / Standard-Links     | `web/src/components/Footer.astro`          |
| Footer-Styling                        | `web/src/styles/global.css` → `footer { }` |
| Farben, Spacing, Typografie           | `web/src/styles/tokens.css`                |

### Neue Seite erstellen

```astro
---
import AppLayout from '../layouts/AppLayout.astro';
---
<AppLayout title="Meine Seite">
  <Fragment slot="nav">
    <div class="nav-links"><a href="/">Start</a></div>
  </Fragment>

  <main>Seiteninhalt</main>
</AppLayout>
```

### Frontend bauen & entwickeln

```bash
cd web
npm run dev     # Astro Dev-Server (Port 4321, Hot Reload)
npm run build   # Statischer Build → web/dist/
```

Nach `npm run build` ist der neue Stand sofort über den Express-Server aktiv (kein Neustart nötig).

---

## Entwicklung

```bash
npm run dev                        # Startet mit --watch (Hot Reload)
npm test                           # Jest-Tests ausführen
npx jest tests/admin.test.js       # Einzelne Test-Datei ausführen
node server/migrate.js             # Migrationen manuell ausführen
```

---

## Datenbank-Migrationen

Migrationen laufen **automatisch** beim Serverstart. Neue Dateien in `server/migrations/` werden beim nächsten Start einmalig ausgeführt.

**Neue Migration erstellen** (`server/migrations/NNNN_beschreibung.js`):

```js
import { DB_SCHEMA } from '../db-schema.js';

export function up(db) {
    // kein async – better-sqlite3 ist synchron
    db.exec(`
        CREATE TABLE IF NOT EXISTS meine_tabelle (
            id         TEXT NOT NULL PRIMARY KEY,
            name       TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
    `);
}
export default up;
```

> Nummerierung: vierstellig, fortlaufend (z.B. `0022_neue_tabelle.js`). Foreign Keys inline in `CREATE TABLE` — kein `ALTER TABLE` nötig.

---

## API-Übersicht

### Public (`/api/v1/`) — kein Auth

| Methode | Route             | Beschreibung                                  |
| ------- | ----------------- | --------------------------------------------- |
| `GET`   | `/setup-status`   | Prüft ob Setup benötigt wird                  |
| `POST`  | `/setup`          | Erstellt ersten Superadmin (einmalig)         |
| `POST`  | `/validate`       | Lizenz-Key validieren (Domain, Device, Nonce) |
| `POST`  | `/heartbeat`      | Letzten Aktivitätszeitpunkt aktualisieren     |
| `POST`  | `/refresh`        | Lizenz-Token erneuern                         |
| `POST`  | `/offline-token`  | Offline-Token ausstellen (max. 168h)          |
| `GET`   | `/public-key`     | RSA-Öffentlichschlüssel abrufen               |
| `POST`  | `/trial/register` | 30-Tage Trial-Lizenz registrieren             |

### Admin (`/api/admin/`) — Admin JWT

Vollständiges CRUD für Lizenzen, Kunden, Rechnungen, Geräte, Webhooks und Einstellungen. Login via `POST /api/admin/login`.

### Kunden-Portal (`/api/portal/`) — Portal JWT

Selbstverwaltung: Profil, Domains, Rechnungsdownload. Login via `POST /api/portal/login`.

---

## Sicherheit

- Alle Secrets werden als kryptografisch sichere Zufallswerte generiert (96 Hex-Zeichen, RSA 2048-bit)
- RS256 für Lizenz-Tokens — CMS verifiziert lokal gegen Public Key ohne API-Rückfrage
- Admin-API mit `ADMIN_IP_WHITELIST` auf bekannte IPs beschränkbar
- 2FA für alle Admin-Accounts über TOTP/Authenticator-App

---

## Update

```bash
bash update.sh
```

Sichert `.env` und Datenbank, holt die neueste Version von GitHub, installiert Dependencies und startet den Server neu.

---

## Lizenz

MIT
