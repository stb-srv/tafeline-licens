// Vollständiges SQLite-Schema — ersetzt alle vorherigen MySQL-Migrationen (0001–0019).
// Jede Tabelle wird mit dem finalen Stand aller aufgelaufenen Migrationen angelegt.

export function up(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS admins (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            username            TEXT NOT NULL UNIQUE,
            password_hash       TEXT NOT NULL,
            role                TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','superadmin')),
            active              INTEGER DEFAULT 1,
            two_factor_secret   TEXT DEFAULT NULL,
            two_factor_enabled  INTEGER DEFAULT 0,
            created_at          TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS customers (
            id                   TEXT NOT NULL PRIMARY KEY,
            name                 TEXT NOT NULL,
            email                TEXT NOT NULL,
            phone                TEXT,
            contact_person       TEXT,
            company              TEXT,
            payment_status       TEXT DEFAULT 'unknown' CHECK(payment_status IN ('paid','pending','overdue','unknown')),
            notes                TEXT,
            archived             INTEGER DEFAULT 0,
            password_hash        TEXT,
            must_change_password INTEGER DEFAULT 0,
            portal_token         TEXT,
            portal_token_expires TEXT,
            portal_username      TEXT UNIQUE,
            billing_street       TEXT,
            billing_city         TEXT,
            billing_zip          TEXT,
            billing_country      TEXT DEFAULT 'DE',
            billing_address      TEXT,
            tax_id               TEXT,
            currency             TEXT DEFAULT 'EUR',
            verified             INTEGER NOT NULL DEFAULT 0,
            email_verify_token   TEXT,
            email_verify_expires TEXT,
            created_at           TEXT DEFAULT (datetime('now')),
            updated_at           TEXT DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS reseller_keys (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            api_key     TEXT NOT NULL UNIQUE,
            name        TEXT NOT NULL,
            email       TEXT,
            max_trials  INTEGER NOT NULL DEFAULT 10,
            used_trials INTEGER NOT NULL DEFAULT 0,
            active      INTEGER NOT NULL DEFAULT 1,
            notes       TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS licenses (
            license_key             TEXT NOT NULL PRIMARY KEY,
            type                    TEXT NOT NULL DEFAULT 'FREE' CHECK(type IN ('FREE','STARTER','PRO','PRO_PLUS','ENTERPRISE','TRIAL')),
            customer_id             TEXT,
            customer_name           TEXT,
            status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','revoked','expired','cancelled','pending_payment')),
            associated_domain       TEXT DEFAULT '*',
            expires_at              TEXT NOT NULL,
            allowed_modules         TEXT,
            limits                  TEXT,
            max_devices             INTEGER DEFAULT 0,
            usage_count             INTEGER DEFAULT 0,
            last_validated          TEXT,
            last_heartbeat          TEXT,
            validated_domain        TEXT,
            validated_domains       TEXT,
            analytics_daily         TEXT,
            analytics_features      TEXT,
            webhook_url             TEXT,
            expiry_notified_at      TEXT,
            expiry_notified_7d_at   TEXT,
            tags                    TEXT NOT NULL DEFAULT '[]',
            notes                   TEXT,
            max_instances           INTEGER NOT NULL DEFAULT 1,
            instance_count          INTEGER NOT NULL DEFAULT 1,
            reseller_id             INTEGER REFERENCES reseller_keys(id) ON DELETE SET NULL,
            created_at              TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS devices (
            id            TEXT NOT NULL PRIMARY KEY,
            license_key   TEXT NOT NULL,
            device_id     TEXT NOT NULL,
            device_type   TEXT DEFAULT 'unknown',
            ip            TEXT,
            first_seen    TEXT DEFAULT (datetime('now')),
            last_seen     TEXT DEFAULT (datetime('now')),
            active        INTEGER DEFAULT 1,
            deactivated_at TEXT,
            FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id      TEXT NOT NULL PRIMARY KEY,
            ts      TEXT DEFAULT (datetime('now')),
            actor   TEXT DEFAULT 'system',
            action  TEXT NOT NULL,
            details TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);
        CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log (ts);

        CREATE TABLE IF NOT EXISTS used_nonces (
            val TEXT NOT NULL PRIMARY KEY,
            ts  INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_nonces_ts ON used_nonces (ts);

        CREATE TABLE IF NOT EXISTS smtp_config (
            id         INTEGER PRIMARY KEY DEFAULT 1,
            host       TEXT,
            port       TEXT DEFAULT '587',
            secure     TEXT DEFAULT 'false',
            smtp_user  TEXT,
            smtp_pass  TEXT,
            smtp_from  TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS webhooks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            url        TEXT NOT NULL,
            secret     TEXT,
            events     TEXT,
            active     INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS admin_sessions (
            id             TEXT NOT NULL PRIMARY KEY,
            admin_username TEXT NOT NULL,
            token_hash     TEXT NOT NULL UNIQUE,
            ip             TEXT,
            user_agent     TEXT,
            revoked        INTEGER NOT NULL DEFAULT 0,
            expires_at     TEXT NOT NULL,
            created_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_admin_sess_token   ON admin_sessions (token_hash);
        CREATE INDEX IF NOT EXISTS idx_admin_sess_expires ON admin_sessions (expires_at);

        CREATE TABLE IF NOT EXISTS customer_sessions (
            id          TEXT NOT NULL PRIMARY KEY,
            customer_id TEXT NOT NULL,
            token_hash  TEXT NOT NULL UNIQUE,
            ip          TEXT,
            user_agent  TEXT,
            revoked     INTEGER NOT NULL DEFAULT 0,
            expires_at  TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_cust_sess_token   ON customer_sessions (token_hash);
        CREATE INDEX IF NOT EXISTS idx_cust_sess_expires ON customer_sessions (expires_at);

        CREATE TABLE IF NOT EXISTS purchase_history (
            id          TEXT NOT NULL PRIMARY KEY,
            customer_id TEXT,
            license_key TEXT,
            plan        TEXT,
            action      TEXT NOT NULL DEFAULT 'purchase',
            amount      REAL,
            note        TEXT,
            created_by  TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_ph_customer ON purchase_history (customer_id);
        CREATE INDEX IF NOT EXISTS idx_ph_license  ON purchase_history (license_key);

        CREATE TABLE IF NOT EXISTS license_heartbeats (
            license_key TEXT NOT NULL PRIMARY KEY,
            ip          TEXT,
            user_agent  TEXT,
            ts          TEXT NOT NULL,
            FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS webhook_logs (
            id            TEXT NOT NULL PRIMARY KEY,
            webhook_url   TEXT NOT NULL,
            event         TEXT NOT NULL,
            status        TEXT NOT NULL CHECK(status IN ('success','failed')),
            error_message TEXT,
            attempted_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_whl_attempted ON webhook_logs (attempted_at);
        CREATE INDEX IF NOT EXISTS idx_whl_status    ON webhook_logs (status);

        CREATE TABLE IF NOT EXISTS invoices (
            id             TEXT NOT NULL PRIMARY KEY,
            invoice_number TEXT NOT NULL UNIQUE,
            customer_id    TEXT NOT NULL,
            license_key    TEXT,
            status         TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','paid','overdue','cancelled')),
            type           TEXT DEFAULT 'invoice' CHECK(type IN ('invoice','credit_note','reminder','renewal')),
            amount_net     REAL NOT NULL,
            amount_tax     REAL NOT NULL DEFAULT 0,
            amount_gross   REAL NOT NULL,
            tax_rate       REAL NOT NULL DEFAULT 19.0,
            currency       TEXT NOT NULL DEFAULT 'EUR',
            due_date       TEXT,
            paid_at        TEXT,
            sent_at        TEXT,
            notes          TEXT,
            pdf_path       TEXT,
            created_by     TEXT DEFAULT 'system',
            resent_count   INTEGER DEFAULT 0,
            resent_at      TEXT,
            created_at     TEXT DEFAULT (datetime('now')),
            updated_at     TEXT,
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
            FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_inv_customer ON invoices (customer_id);
        CREATE INDEX IF NOT EXISTS idx_inv_license  ON invoices (license_key);
        CREATE INDEX IF NOT EXISTS idx_inv_status   ON invoices (status);
        CREATE INDEX IF NOT EXISTS idx_inv_due_date ON invoices (due_date);

        CREATE TABLE IF NOT EXISTS invoice_items (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id  TEXT NOT NULL,
            description TEXT NOT NULL,
            quantity    REAL NOT NULL DEFAULT 1.0,
            unit_price  REAL NOT NULL,
            total       REAL NOT NULL,
            sort_order  INTEGER DEFAULT 0,
            FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_items_invoice ON invoice_items (invoice_id);

        CREATE TABLE IF NOT EXISTS invoice_settings (
            id              INTEGER PRIMARY KEY DEFAULT 1,
            company_name    TEXT,
            company_address TEXT,
            company_tax_id  TEXT,
            company_iban    TEXT,
            company_bic     TEXT,
            invoice_prefix  TEXT DEFAULT 'INV',
            next_number     INTEGER DEFAULT 1,
            logo_path       TEXT,
            footer_text     TEXT,
            updated_at      TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS menu (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            license_key TEXT,
            category    TEXT,
            name        TEXT NOT NULL,
            description TEXT,
            price       REAL,
            sort_order  INTEGER DEFAULT 0,
            active      INTEGER DEFAULT 1,
            created_at  TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE
        );
    `);

    // Seed default invoice settings
    const existing = db.prepare('SELECT COUNT(*) AS n FROM invoice_settings WHERE id = 1').get();
    if (existing.n === 0) {
        db.prepare(
            `INSERT INTO invoice_settings (id, company_name, company_address, invoice_prefix, next_number)
             VALUES (1, 'Tafeline', 'Main Street 42, 10115 Berlin', 'INV', 1)`
        ).run();
    }

    console.log('  ✅ Vollständiges SQLite-Schema erstellt.');
}

export default up;
