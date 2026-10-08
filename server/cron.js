import db from './db.js';
import { sendTemplateMail } from './mailer/index.js';
import { addAuditLog } from './helpers.js';
import { fireWebhook } from './webhook.js';
import { createInvoiceFromLicense } from './invoiceHelper.js';
import { runBackup, rotateBackups } from './backup.js';
import { sendAlert } from './alerts.js';
import logger from './logger.js';

export async function runExpiryCron() {
    try {
        // Configurable reminder intervals (days before expiry), read from settings
        let intervals = [90, 30, 7, 1];
        try {
            const [[settings]] = db.query(
                'SELECT expiry_warn_days_1, expiry_warn_days_2, expiry_warn_days_3, expiry_warn_days_4 FROM invoice_settings WHERE id = 1'
            );
            if (settings) {
                intervals = [
                    settings.expiry_warn_days_1 || 90,
                    settings.expiry_warn_days_2 || 30,
                    settings.expiry_warn_days_3 || 7,
                    settings.expiry_warn_days_4 || 1,
                ]
                    .map(Number)
                    .filter((n) => n > 0)
                    .sort((a, b) => b - a);
            }
        } catch {
            /* use defaults */
        }

        const maxDays = intervals[0];
        const [expiring] = db.query(`
            SELECT l.license_key, l.customer_name, l.type, l.expires_at, l.notes, c.email
            FROM licenses l
            LEFT JOIN customers c ON l.customer_id = c.id
            WHERE l.status = 'active'
              AND l.expires_at BETWEEN datetime('now') AND datetime('now', '+${maxDays} days')
        `);

        for (const lic of expiring) {
            let email = lic.email;
            if (!email && lic.notes) {
                try {
                    email = JSON.parse(lic.notes).contact_email || null;
                } catch {
                    /* notes ist kein gültiges JSON – Kontakt-E-Mail ignorieren */
                }
            }
            if (!email) continue;

            const daysLeft = Math.ceil((new Date(lic.expires_at) - new Date()) / 86400000);
            const matchedInterval = intervals.find((d) => daysLeft <= d);
            if (!matchedInterval) continue;

            // Idempotency: skip if already sent this reminder level
            const [[sent]] = db.query(
                'SELECT 1 FROM renewal_reminders WHERE license_key = ? AND days_before = ?',
                [lic.license_key, matchedInterval]
            );
            if (sent) continue;

            const template = matchedInterval <= 1 ? 'licenseExpiring7d' : 'licenseExpiringSoon';
            try {
                await sendTemplateMail(template, email, {
                    customer_name: lic.customer_name,
                    license_key: lic.license_key,
                    type: lic.type,
                    expires_at: lic.expires_at,
                    days_left: daysLeft,
                });
                db.query(
                    'INSERT INTO renewal_reminders (license_key, days_before) VALUES (?, ?) ON CONFLICT DO NOTHING',
                    [lic.license_key, matchedInterval]
                );
                await addAuditLog('expiry_notification_sent', {
                    license_key: lic.license_key,
                    days_left: daysLeft,
                    interval: matchedInterval,
                    email,
                });
            } catch (e) {
                logger.warn({ err: e }, `📧 Ablauf-Mail fehlgeschlagen für ${lic.license_key}:`);
            }
        }

        const [result] = db.query(
            `UPDATE licenses SET status = 'expired' WHERE status = 'active' AND expires_at < datetime('now')`
        );
        if (result.affectedRows > 0) {
            logger.info(`🕐 ${result.affectedRows} Lizenz(en) auf 'expired' gesetzt.`);
            await addAuditLog('licenses_auto_expired', { count: result.affectedRows });
            await fireWebhook('licenses.auto_expired', { count: result.affectedRows });
        }
    } catch (e) {
        logger.error({ err: e }, 'Expiry-Cron Fehler:');
    }
}

export async function runNonceCleanup() {
    try {
        const [nonceResult] = db.query('DELETE FROM used_nonces WHERE ts < ?', [
            Date.now() - 2 * 60 * 60 * 1000,
        ]);
        if (nonceResult.affectedRows > 0)
            logger.info(`🧹 ${nonceResult.affectedRows} abgelaufene Nonce(s) bereinigt.`);

        const [sessResult] = db.query(
            `DELETE FROM customer_sessions WHERE expires_at < datetime('now') OR revoked = 1`
        );
        if (sessResult.affectedRows > 0)
            logger.info(`🧹 ${sessResult.affectedRows} abgelaufene Kunden-Session(s) bereinigt.`);

        const [adminSessResult] = db.query(
            `DELETE FROM admin_sessions WHERE expires_at < datetime('now') OR revoked = 1`
        );
        if (adminSessResult.affectedRows > 0)
            logger.info(
                `🧹 ${adminSessResult.affectedRows} abgelaufene Admin-Session(s) bereinigt.`
            );
    } catch (e) {
        logger.error({ err: e }, 'Nonce/Session-Cleanup Fehler:');
    }
}

const DUNNING_TEMPLATE = {
    1: 'invoiceDunning1',
    2: 'invoiceDunning2',
    3: 'invoiceDunning3',
    4: 'invoiceDunningFinal',
};

export async function runOverdueInvoiceCron() {
    try {
        const portalUrl = (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');

        const [overdueInvoices] = db.query(`
            SELECT i.id, i.invoice_number, i.customer_id, i.amount_gross, i.due_date,
                   i.dunning_level,
                   CAST(julianday('now') - julianday(i.due_date) AS INTEGER) AS days_overdue,
                   c.email, c.name AS customer_name
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            WHERE i.status IN ('sent', 'overdue') AND i.due_date < date('now')
        `);

        for (const invoice of overdueInvoices) {
            try {
                const daysOverdue = Math.max(0, invoice.days_overdue || 0);
                const currentLevel = invoice.dunning_level || 0;

                let targetLevel = currentLevel;
                if (daysOverdue >= 30 && currentLevel < 4) targetLevel = 4;
                else if (daysOverdue >= 21 && currentLevel < 3) targetLevel = 3;
                else if (daysOverdue >= 7 && currentLevel < 2) targetLevel = 2;
                else if (daysOverdue >= 1 && currentLevel < 1) targetLevel = 1;

                if (targetLevel <= currentLevel) continue;

                db.runTransaction(() => {
                    db.query(
                        "UPDATE invoices SET status = 'overdue', dunning_level = ? WHERE id = ?",
                        [targetLevel, invoice.id]
                    );
                    db.query("UPDATE customers SET payment_status = 'overdue' WHERE id = ?", [
                        invoice.customer_id,
                    ]);
                });

                if (targetLevel === 4) {
                    const [suspended] = db.query(
                        "UPDATE licenses SET status = 'suspended' WHERE customer_id = ? AND status = 'active'",
                        [invoice.customer_id]
                    );
                    if (suspended.affectedRows > 0)
                        await addAuditLog('licenses_suspended_overdue', {
                            customer_id: invoice.customer_id,
                            invoice_id: invoice.id,
                        });
                }

                await addAuditLog('invoice_dunning', {
                    invoice_id: invoice.id,
                    invoice_number: invoice.invoice_number,
                    customer_id: invoice.customer_id,
                    dunning_level: targetLevel,
                    days_overdue: daysOverdue,
                });

                if (invoice.email) {
                    try {
                        await sendTemplateMail(DUNNING_TEMPLATE[targetLevel], invoice.email, {
                            customer_name: invoice.customer_name,
                            invoice_number: invoice.invoice_number,
                            amount_gross: invoice.amount_gross,
                            due_date: invoice.due_date,
                            days_overdue: daysOverdue,
                            dunning_level: targetLevel,
                            invoice_url: `${portalUrl}/portal.html?tab=invoices`,
                        });
                    } catch (mailErr) {
                        logger.warn(
                            { err: mailErr },
                            `📧 Dunning-Mail fehlgeschlagen für ${invoice.invoice_number}:`
                        );
                    }
                }
            } catch (err) {
                logger.error(
                    { err: err },
                    `Fehler bei Dunning für Rechnung ${invoice.invoice_number}:`
                );
            }
        }
    } catch (e) {
        logger.error({ err: e }, 'Overdue-Invoice-Cron Fehler:');
    }
}

export async function runAutoInvoiceCron() {
    try {
        const [licenses] = db.query(`
            SELECT l.license_key, l.type, l.customer_id
            FROM licenses l
            WHERE l.status = 'active'
              AND l.type IN ('STARTER', 'PRO', 'PRO_PLUS', 'ENTERPRISE')
              AND l.expires_at BETWEEN datetime('now') AND datetime('now', '+7 days')
        `);

        for (const lic of licenses) {
            const [existing] = db.query(
                `SELECT id FROM invoices WHERE license_key = ? AND created_at > datetime('now', '-30 days') LIMIT 1`,
                [lic.license_key]
            );
            if (existing.length > 0) continue;

            try {
                const invoiceId = createInvoiceFromLicense(lic.license_key, 'cron');
                await addAuditLog('invoice_auto_generated', {
                    license_key: lic.license_key,
                    invoice_id: invoiceId,
                    customer_id: lic.customer_id,
                });
                logger.info(`🧾 Auto-Rechnung (Draft) erstellt für Lizenz: ${lic.license_key}`);
            } catch (err) {
                logger.error(
                    { err: err },
                    `Fehler bei Auto-Rechnung für Lizenz ${lic.license_key}:`
                );
            }
        }
    } catch (e) {
        logger.error({ err: e }, 'Auto-Invoice-Cron Fehler:');
    }
}

export async function runBackupCron() {
    try {
        const dest = await runBackup();
        const removed = rotateBackups();
        if (removed > 0) logger.info(`🗑️  Backup-Rotation: ${removed} alte Backups gelöscht.`);
        return dest;
    } catch (e) {
        logger.error({ err: e }, '❌ Backup-Cron Fehler:');
        await sendAlert(
            'Backup fehlgeschlagen',
            `Das tägliche Datenbank-Backup ist fehlgeschlagen: ${e.message}`
        );
    }
}

export function startCron() {
    setInterval(runExpiryCron, 24 * 60 * 60 * 1000);
    runExpiryCron();
    setInterval(runNonceCleanup, 60 * 60 * 1000);
    runNonceCleanup();
    setInterval(runOverdueInvoiceCron, 24 * 60 * 60 * 1000);
    runOverdueInvoiceCron();
    setInterval(runAutoInvoiceCron, 24 * 60 * 60 * 1000);
    runAutoInvoiceCron();
    setInterval(runBackupCron, 24 * 60 * 60 * 1000);
    runBackupCron();
}

export async function createInvoiceForLicense(licenseId) {
    try {
        const invoiceId = createInvoiceFromLicense(licenseId, 'system');
        await addAuditLog('invoice_auto_generated', {
            license_key: licenseId,
            invoice_id: invoiceId,
        });
        logger.info(`🧾 Auto-Rechnung (Draft) erstellt für Lizenz bei Erstellung: ${licenseId}`);
        return invoiceId;
    } catch (err) {
        logger.error({ err: err }, `Fehler bei Auto-Rechnung für Lizenz ${licenseId}:`);
        throw err;
    }
}

export async function createInvoiceForRenewal(licenseId) {
    try {
        const invoiceId = createInvoiceFromLicense(licenseId, 'system');
        db.query("UPDATE invoices SET type = 'renewal' WHERE id = ?", [invoiceId]);
        await addAuditLog('invoice_auto_generated', {
            license_key: licenseId,
            invoice_id: invoiceId,
            type: 'renewal',
        });
        logger.info(
            `🧾 Auto-Rechnung (Renewal) erstellt für Lizenz bei Verlängerung: ${licenseId}`
        );
        return invoiceId;
    } catch (err) {
        logger.error({ err: err }, `Fehler bei Auto-Rechnung (Renewal) für Lizenz ${licenseId}:`);
        throw err;
    }
}
