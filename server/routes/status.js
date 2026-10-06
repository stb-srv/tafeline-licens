import { Router } from 'express';
import db from '../db.js';

const router = Router();

router.get('/', (req, res) => {
    const checks = {};
    let overallOk = true;

    try {
        db.query('SELECT 1');
        checks.database = { ok: true, label: 'Datenbank' };
    } catch (e) {
        checks.database = { ok: false, label: 'Datenbank', error: e.message };
        overallOk = false;
    }

    try {
        const [[row]] = db.query('SELECT COUNT(*) as c FROM licenses WHERE status = "active"');
        checks.licenses = { ok: true, label: 'Lizenz-API', active_licenses: row.c };
    } catch (e) {
        checks.licenses = { ok: false, label: 'Lizenz-API', error: e.message };
        overallOk = false;
    }

    const mailerOk = !!(process.env.SMTP_HOST && process.env.SMTP_USER);
    checks.mailer = { ok: mailerOk, label: 'E-Mail / SMTP', configured: mailerOk };

    const html = `<!DOCTYPE html>
    <html lang="de"><head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="60">
        <title>Tafeline Lizenz-Server – Status</title>
        <style>
            body { font-family:sans-serif; max-width:600px; margin:60px auto; padding:0 24px; color:#111; background:#f3f4f6; }
            .card { background:#fff; padding:32px; border-radius:16px; box-shadow:0 4px 6px -1px rgba(0,0,0,0.1); }
            h1 { font-size:1.4rem; margin-bottom:4px; display:flex; align-items:center; gap:8px; }
            .badge { display:inline-block; padding:6px 18px; border-radius:20px; font-weight:700; font-size:.9rem; margin-bottom:28px; }
            .badge.ok   { background:#dcfce7; color:#166534; }
            .badge.fail { background:#fee2e2; color:#991b1b; }
            .check { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-radius:10px; margin-bottom:10px; background:#f9fafb; border:1px solid #e5e7eb; }
            .dot { width:12px; height:12px; border-radius:50%; }
            .dot.ok   { background:#16a34a; box-shadow: 0 0 8px rgba(22, 163, 74, 0.4); }
            .dot.fail { background:#dc2626; box-shadow: 0 0 8px rgba(220, 38, 38, 0.4); }
            footer { margin-top:40px; font-size:.75rem; color:#9ca3af; text-align:center; }
        </style>
    </head><body>
        <div class="card">
            <h1>🟢 Tafeline Lizenz-Server</h1>
            <span class="badge ${overallOk ? 'ok' : 'fail'}">${overallOk ? '✓ Alle Systeme operational' : '✗ Störung erkannt'}</span>
            ${Object.values(checks)
                .map(
                    (c) =>
                        `<div class="check"><span>${c.label}</span><div class="dot ${c.ok ? 'ok' : 'fail'}"></div></div>`
                )
                .join('')}
        </div>
        <footer>Automatisch aktualisiert alle 60s · ${new Date().toLocaleString('de-DE')}</footer>
    </body></html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
});

router.get('/json', (req, res) => {
    try {
        db.query('SELECT 1');
        res.json({ ok: true, ts: new Date().toISOString() });
    } catch (e) {
        res.status(503).json({ ok: false, error: e.message, ts: new Date().toISOString() });
    }
});

router.get('/metrics', (req, res) => {
    const lines = [];
    const g = (name, help, value, labels = '') => {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} gauge`);
        lines.push(labels ? `${name}{${labels}} ${value}` : `${name} ${value}`);
    };

    try {
        const statusMap = { active: 0, expired: 0, suspended: 0, trial: 0, grace: 0 };
        const [licRows] = db.query('SELECT status, COUNT(*) as c FROM licenses GROUP BY status');
        for (const r of licRows) if (r.status in statusMap) statusMap[r.status] = r.c;
        for (const [status, count] of Object.entries(statusMap))
            g('tafeline_licenses_total', 'Total licenses by status', count, `status="${status}"`);

        const [[{ customers }]] = db.query(
            'SELECT COUNT(*) as customers FROM customers WHERE archived = 0 OR archived IS NULL'
        );
        g('tafeline_customers_total', 'Total active customers', customers);

        const [[{ invoices_open }]] = db.query(
            "SELECT COUNT(*) as invoices_open FROM invoices WHERE status IN ('sent','overdue')"
        );
        g('tafeline_invoices_open_total', 'Open and overdue invoices', invoices_open);

        const [[{ wh_ok }]] = db.query(
            "SELECT COUNT(*) as wh_ok FROM webhook_logs WHERE status='success' AND attempted_at > datetime('now','-24 hours')"
        );
        const [[{ wh_fail }]] = db.query(
            "SELECT COUNT(*) as wh_fail FROM webhook_logs WHERE status='failed' AND attempted_at > datetime('now','-24 hours')"
        );
        const [[{ wh_dl }]] = db.query(
            'SELECT COUNT(*) as wh_dl FROM webhook_dead_letters WHERE resolved = 0'
        );
        g('tafeline_webhooks_success_24h', 'Successful webhook deliveries in last 24h', wh_ok);
        g('tafeline_webhooks_failed_24h', 'Failed webhook deliveries in last 24h', wh_fail);
        g('tafeline_webhook_dead_letters', 'Unresolved webhook dead letters', wh_dl);

        g('tafeline_uptime_seconds', 'Process uptime in seconds', Math.floor(process.uptime()));
        g('tafeline_memory_rss_bytes', 'RSS memory usage in bytes', process.memoryUsage().rss);
    } catch (e) {
        lines.push(`# ERROR ${e.message}`);
    }

    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(lines.join('\n') + '\n');
});

export default router;
