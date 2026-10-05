# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Commands

> **Umgebungshinweis:** Claude Code läuft in einer Flatpak-Sandbox — `npm` und `node` sind nicht direkt im PATH. Alle Node-Befehle über `flatpak-spawn --host`:

```bash
flatpak-spawn --host npm start
flatpak-spawn --host npm test
flatpak-spawn --host node server/migrate.js
# Env-Vars übergeben:
flatpak-spawn --host sh -c 'DB_PATH=./data/test.db node server.js'
```

```bash
npm start          # Start server (auto-runs DB migrations)
npm run dev        # Start with --watch (hot reload)
npm test           # Run Jest tests (ESM mode)
node server/migrate.js  # Run migrations standalone (for CI/CD or debug)
```

Run a single test file:
```bash
npx jest tests/admin.test.js
```

Generate secrets:
```bash
openssl rand -hex 48
```

---

## Architecture

**Tafeline License Server** — Node.js (ES Modules) REST API for managing restaurant-CMS licenses. Runs standalone behind nginx/PM2, typically on port 4000.

### Entry point: `server.js`

Startup sequence:
1. Validates required env vars (fails fast with `process.exit(1)` on missing secrets)
2. Opens SQLite connection at `DB_PATH` (default: `./data/licens.db`)
3. Runs auto-migrations via `server/migrate.js`
4. Mounts routes and starts Express

### Route structure (`server/routes/`)

| Mount path | File | Auth |
|---|---|---|
| `/api/v1/` | `public.js` | None |
| `/api/admin/` | `admin.js`, `admin-licenses.js`, `admin-customers.js`, `admin-invoices.js`, `admin-stats.js`, `admin-settings.js` | `requireAuth` + optionally `requireSuperAdmin` |
| `/api/portal/` | `customer-portal.js` | `requirePortalAuth` |
| `/api/reseller/` | `reseller.js` | API key |
| `/api/status` | `status.js` | None |

### Auth layers (`server/middleware.js`)

| Layer | Token | Secret | Middleware |
|---|---|---|---|
| Admin / Superadmin | JWT RS256 (or HS256 fallback) | `ADMIN_SECRET` / `RSA_PRIVATE_KEY` | `requireAuth` |
| Superadmin only | same | same | `requireAuth` + `requireSuperAdmin` |
| Customer portal | JWT HS256 | `PORTAL_SECRET` | `requirePortalAuth` (in portal route) |
| License token (CMS-side) | JWT RS256 | `RSA_PRIVATE_KEY` | Verified locally by CMS via public key |
| Offline token | HMAC HS256 | `HMAC_SECRET` | Custom validation in `public.js` |

Admin sessions are tracked in the `admin_sessions` DB table (token hash, revocation).

### Key modules

- **`server/plans.js`** — Re-exports `PLAN_DEFINITIONS` and `PLAN_MODULES` from `@tafeline/plans` (`../tafeline-plans/`). **Nie** Pläne hier direkt definieren — immer im shared Package `tafeline-plans/index.js` bearbeiten, damit CMS und Lizenzserver synchron bleiben.
- **`server/db-schema.js`** — Canonical DB field types (`DB_SCHEMA.FIELDS.*`, `DB_SCHEMA.PK.*`). Always import and use these in migrations instead of hardcoding type strings.
- **`server/invoiceHelper.js`** — Invoice creation logic, number sequences, PDF triggering. Functions are synchronous.
- **`server/pdfGenerator.js`** — `pdfkit`-based PDF generation; PDFs saved under `STORAGE_PATH/invoices/`.
- **`server/cron.js`** — Cron jobs: nonce cleanup, invoice due-date checker, license expiry email warnings.
- **`server/helpers.js`** — `asyncHandler` wrapper and shared utilities; DB logic goes here (not inline in routes).
- **`server/webhook.js`** — HTTP POST dispatcher for external systems on license/invoice events.

### Database (SQLite / better-sqlite3)

**`server/db.js` exports a synchronous API** — no `await` on DB calls:
```js
const [rows] = db.query('SELECT * FROM licenses WHERE license_key = ?', [key]);
const [[row]] = db.query('SELECT * FROM licenses WHERE license_key = ?', [key]); // first row
const [result] = db.query('INSERT INTO ...', [...]);  // { affectedRows, insertId }
db.runTransaction(() => { db.query(...); db.query(...); }); // atomic, auto-rollback on throw
```

**Dates** — store as ISO strings: `new Date().toISOString().slice(0, 19).replace('T', ' ')`.
Never pass `Date` objects directly to `db.query()` — better-sqlite3 converts them to Unix timestamps.

**SQLite date functions** (replacing MySQL equivalents):
- `NOW()` → `datetime('now')`
- `DATE_ADD(NOW(), INTERVAL 30 DAY)` → `datetime('now', '+30 days')`
- `DATEDIFF(NOW(), col)` → `CAST(julianday('now') - julianday(col) AS INTEGER)`
- `CURDATE()` → `date('now')`
- `DATE_FORMAT(NOW(), '%Y-%m-01')` → `strftime('%Y-%m-01', 'now')`

**LIKE with escape** — always add `ESCAPE '\\'` when the search string is user-supplied:
```js
where += ` AND name LIKE ? ESCAPE '\\'`;
```

**Upsert** — `ON DUPLICATE KEY UPDATE` → `ON CONFLICT(col) DO UPDATE SET x = excluded.x`

**JSON queries** — `JSON_CONTAINS(tags, JSON_QUOTE(?))` → `EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`

### DB migrations (`server/migrations/`)

- Auto-run on every `npm start`; tracked in `schema_migrations` table.
- `0001_schema.js` contains the **complete current schema**. Future migrations start at `0020_...`.
- Naming: `NNNN_short_description.js` (four-digit sequential number).
- Template for new migrations (synchronous):

```js
export function up(db) {   // no async — better-sqlite3 is synchronous
    db.exec(`
        CREATE TABLE IF NOT EXISTS my_table (
            id         TEXT NOT NULL PRIMARY KEY,
            name       TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
    `);
}
export default up;
```

> Foreign keys are declared inline in `CREATE TABLE` (no `ALTER TABLE` needed). SQLite FK enforcement is enabled via `PRAGMA foreign_keys = ON`.

### Static frontend (`public/`)

Three HTML pages served statically: `index.html` (admin panel), `login.html`, `portal.html` (customer portal). These are served directly by Express.

---

## Code rules

1. **ES Modules only** — `import`/`export` everywhere; no `require()`. Project uses `"type": "module"`.
2. **Use `DB_SCHEMA`** — Never hardcode DB type strings in migrations.
3. **Audit log** — Write to `audit_log` table for all security-relevant actions (login, license changes, deletions).
4. **No DB logic in route handlers** — DB queries belong in `helpers.js`, `invoiceHelper.js`, or new service modules.
5. **Middleware enforcement** — New admin routes need `requireAuth`; superadmin-only routes additionally need `requireSuperAdmin`.
6. **All secrets via `.env`** — Required: `ADMIN_SECRET`, `PORTAL_SECRET`, `HMAC_SECRET`. `DB_PATH` is optional (default `./data/licens.db`). See `.env.example` for the full list.

---

## Tests

Tests live in `tests/` (`admin.test.js`, `portal.test.js`, `public.test.js`). Jest is configured in `jest.config.js` with env vars pre-set. Tests use `jest.spyOn(db, 'query')` mocks — no real database needed.
