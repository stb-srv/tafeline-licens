import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { sendTemplateMail } from '../mailer/index.js';
import rateLimit from 'express-rate-limit';
import { getInvoiceWithItems, createInvoice, createInvoiceFromLicense } from '../invoiceHelper.js';
import { getInvoicePDFBuffer } from '../pdfGenerator.js';
import { PLAN_DEFINITIONS } from '../plans.js';
import {
    generateKey,
    addAuditLog,
    asyncHandler,
    normalizeDomain,
    parseJsonField,
} from '../helpers.js';

const router = Router();
const PORTAL_SECRET = process.env.PORTAL_SECRET || '';

const portalLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Zu viele Login-Versuche. Bitte 15 Minuten warten.' },
});
const inviteLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { success: false, message: 'Zu viele Anfragen. Bitte 1 Stunde warten.' },
});
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: {
        success: false,
        message: 'Zu viele Registrierungs-Versuche. Bitte 1 Stunde warten.',
    },
});
const verifyLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: {
        success: false,
        message: 'Zu viele Verifizierungs-Versuche. Bitte 1 Stunde warten.',
    },
});

function toDbDate(d) {
    return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeSlug(str) {
    return str
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/ß/gi, 'ss')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function buildPortalUsername(name, company = null) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    let slug;
    if (parts.length >= 2)
        slug = `${normalizeSlug(parts[0])}.${normalizeSlug(parts[parts.length - 1])}`;
    else if (parts.length === 1) slug = normalizeSlug(parts[0]);
    else slug = 'kunde';
    if (company) {
        const firmSlug = normalizeSlug(company)
            .replace(/gmbhcokg|gmbhco|gmbh|gbr|ohg|ug|ag|kg|ev|inc|ltd/g, '')
            .replace(/^\d+/, '')
            .slice(0, 12);
        if (firmSlug) slug = `${slug}.${firmSlug}`;
    }
    return slug || 'kunde';
}

function uniquePortalUsername(name, company = null) {
    const base = buildPortalUsername(name, company);
    try {
        for (let i = 0; i < 100; i++) {
            const attempt = i === 0 ? base : `${base}${i}`;
            const [[{ n }]] = db.query(
                'SELECT COUNT(*) AS n FROM customers WHERE portal_username = ?',
                [attempt]
            );
            if (n === 0) return attempt;
        }
        return `${base}${Date.now()}`;
    } catch {
        return base;
    }
}

// ── Auth Middleware ────────────────────────────────────────────────────────────
async function requirePortalAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer '))
        return res.status(401).json({ success: false, message: 'Nicht eingeloggt.' });
    const token = auth.slice(7);
    try {
        if (!PORTAL_SECRET) throw new Error('PORTAL_SECRET nicht konfiguriert.');
        const payload = jwt.verify(token, PORTAL_SECRET);
        if (payload.type !== 'portal') throw new Error('Ungültiger Token-Typ.');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const [rows] = db.query(
            `SELECT * FROM customer_sessions WHERE token_hash=? AND revoked=0 AND expires_at > datetime('now')`,
            [tokenHash]
        );
        if (!rows[0])
            return res
                .status(401)
                .json({ success: false, message: 'Session abgelaufen oder ungültig.' });
        const [custs] = db.query('SELECT * FROM customers WHERE id = ?', [payload.customer_id]);
        if (!custs[0])
            return res.status(401).json({ success: false, message: 'Kunde nicht gefunden.' });
        req.customer = custs[0];
        req.sessionTokenHash = tokenHash;
        if (custs[0].must_change_password) {
            const allowedPaths = ['/change-password', '/logout'];
            if (!allowedPaths.includes(req.path.replace(/\/$/, '') || '/')) {
                return res.status(403).json({
                    success: false,
                    must_change_password: true,
                    message:
                        'Bitte ändere zuerst dein Passwort, bevor du das Portal nutzen kannst.',
                });
            }
        }
        next();
    } catch (e) {
        return res.status(401).json({ success: false, message: 'Token ungültig oder abgelaufen.' });
    }
}

// ── POST /login ───────────────────────────────────────────────────────────────
router.post('/login', portalLoginLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res
            .status(400)
            .json({ success: false, message: 'Benutzername/E-Mail und Passwort erforderlich.' });
    if (!PORTAL_SECRET)
        return res
            .status(500)
            .json({ success: false, message: 'Portal nicht konfiguriert (PORTAL_SECRET fehlt).' });
    try {
        const login = email.toLowerCase().trim();
        const [rows] = db.query('SELECT * FROM customers WHERE email=? OR portal_username=?', [
            login,
            login,
        ]);
        const customer = rows[0];
        if (!customer || !customer.password_hash)
            return res
                .status(401)
                .json({ success: false, message: 'Benutzername/E-Mail oder Passwort falsch.' });
        if (!(await bcrypt.compare(password, customer.password_hash)))
            return res
                .status(401)
                .json({ success: false, message: 'Benutzername/E-Mail oder Passwort falsch.' });
        if (customer.verified === 0) {
            return res.status(403).json({
                success: false,
                message: 'Bitte bestätige zuerst deine E-Mail-Adresse.',
                email_not_verified: true,
            });
        }

        const token = jwt.sign(
            { customer_id: customer.id, email: customer.email, type: 'portal' },
            PORTAL_SECRET,
            { expiresIn: '24h' }
        );
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        db.query(
            `INSERT INTO customer_sessions (id, customer_id, token_hash, ip, user_agent, expires_at)
             VALUES (?, ?, ?, ?, ?, datetime('now', '+24 hours'))`,
            [
                crypto.randomUUID(),
                customer.id,
                tokenHash,
                req.ip || null,
                (req.headers['user-agent'] || '').slice(0, 512),
            ]
        );
        res.json({
            success: true,
            token,
            customer: {
                id: customer.id,
                name: customer.name,
                email: customer.email,
                username: customer.portal_username || null,
                company: customer.company || null,
            },
        });
    } catch (e) {
        console.error('[Portal/login]', e.message);
        res.status(500).json({ success: false, message: 'Interner Fehler.' });
    }
});

// ── POST /logout ──────────────────────────────────────────────────────────────
router.post('/logout', requirePortalAuth, async (req, res) => {
    try {
        db.query('UPDATE customer_sessions SET revoked=1 WHERE token_hash=?', [
            req.sessionTokenHash,
        ]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fehler beim Logout.' });
    }
});

// ── GET /me ───────────────────────────────────────────────────────────────────
router.get('/me', requirePortalAuth, async (req, res) => {
    const c = req.customer;
    res.json({
        success: true,
        customer: {
            id: c.id,
            name: c.name,
            email: c.email,
            username: c.portal_username || null,
            company: c.company || null,
            phone: c.phone || null,
            payment_status: c.payment_status || 'unknown',
            must_change_password: c.must_change_password ? true : false,
            created_at: c.created_at,
            billing_street: c.billing_street || null,
            billing_city: c.billing_city || null,
            billing_zip: c.billing_zip || null,
            billing_country: c.billing_country || null,
            tax_id: c.tax_id || null,
        },
    });
});

// ── PATCH /update-profile ─────────────────────────────────────────────────────
router.patch('/update-profile', requirePortalAuth, async (req, res) => {
    const {
        name,
        phone,
        company,
        billing_street,
        billing_city,
        billing_zip,
        billing_country,
        tax_id,
    } = req.body;
    if (name !== undefined && (typeof name !== 'string' || name.trim().length < 2))
        return res
            .status(400)
            .json({ success: false, message: 'Name muss mindestens 2 Zeichen lang sein.' });
    if (billing_zip !== undefined && billing_zip !== null) {
        const zipStr = String(billing_zip).trim();
        if (zipStr.length > 10 || (zipStr.length > 0 && !/^[a-zA-Z0-9]+$/.test(zipStr)))
            return res.status(400).json({ success: false, message: 'Postleitzahl ist ungültig.' });
    }
    if (billing_country !== undefined && billing_country !== null) {
        if (!/^[a-zA-Z]{2}$/.test(String(billing_country).trim()))
            return res.status(400).json({
                success: false,
                message: 'Ungültiges Land (2-stelliger ISO-Code erforderlich).',
            });
    }

    const updates = [],
        params = [];
    if (name !== undefined) {
        updates.push('name=?');
        params.push(name.trim());
    }
    if (phone !== undefined) {
        updates.push('phone=?');
        params.push(phone || null);
    }
    if (company !== undefined) {
        updates.push('company=?');
        params.push(company || null);
    }
    if (billing_street !== undefined) {
        updates.push('billing_street=?');
        params.push(billing_street || null);
    }
    if (billing_city !== undefined) {
        updates.push('billing_city=?');
        params.push(billing_city || null);
    }
    if (billing_zip !== undefined) {
        updates.push('billing_zip=?');
        params.push(billing_zip ? String(billing_zip).trim() : null);
    }
    if (billing_country !== undefined) {
        updates.push('billing_country=?');
        params.push(billing_country ? String(billing_country).trim().toUpperCase() : null);
    }
    if (tax_id !== undefined) {
        updates.push('tax_id=?');
        params.push(tax_id || null);
    }

    if (updates.length === 0)
        return res
            .status(400)
            .json({ success: false, message: 'Keine änderbaren Felder angegeben.' });

    try {
        params.push(req.customer.id);
        db.query(`UPDATE customers SET ${updates.join(', ')} WHERE id=?`, params);
        const [rows] = db.query(
            'SELECT id, name, email, phone, company, portal_username, billing_street, billing_city, billing_zip, billing_country, tax_id FROM customers WHERE id=?',
            [req.customer.id]
        );
        const c = rows[0];
        res.json({
            success: true,
            message: 'Profil erfolgreich aktualisiert.',
            customer: {
                id: c.id,
                name: c.name,
                email: c.email,
                username: c.portal_username || null,
                phone: c.phone || null,
                company: c.company || null,
                billing_street: c.billing_street || null,
                billing_city: c.billing_city || null,
                billing_zip: c.billing_zip || null,
                billing_country: c.billing_country || null,
                tax_id: c.tax_id || null,
            },
        });
    } catch (e) {
        console.error('[Portal/update-profile]', e.message);
        res.status(500).json({ success: false, message: 'Interner Fehler.' });
    }
});

// ── GET /licenses ─────────────────────────────────────────────────────────────
router.get('/licenses', requirePortalAuth, async (req, res) => {
    try {
        const [licenses] = db.query(
            `SELECT license_key, type, status, associated_domain, expires_at, usage_count, last_validated, max_devices, created_at
             FROM licenses WHERE customer_id=? ORDER BY created_at DESC`,
            [req.customer.id]
        );
        res.json({ success: true, licenses });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fehler beim Laden der Lizenzen.' });
    }
});

// ── POST /licenses/:key/upgrade ──────────────────────────────────────────────
const UPGRADE_ORDER = { FREE: 0, TRIAL: 0, STARTER: 1, PRO: 2, PRO_PLUS: 3, ENTERPRISE: 4 };

router.post(
    '/licenses/:key/upgrade',
    requirePortalAuth,
    asyncHandler(async (req, res) => {
        const { key } = req.params;
        const { new_type } = req.body;
        const upgradableTypes = ['STARTER', 'PRO', 'PRO_PLUS', 'ENTERPRISE'];

        if (!new_type || !upgradableTypes.includes(new_type))
            return res.status(400).json({
                success: false,
                message: `Ungültiger Plan. Erlaubt: ${upgradableTypes.join(', ')}`,
            });

        const [[license]] = db.query(
            'SELECT * FROM licenses WHERE license_key = ? AND customer_id = ?',
            [key, req.customer.id]
        );
        if (!license)
            return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden.' });
        if (license.status !== 'active')
            return res
                .status(400)
                .json({ success: false, message: 'Nur aktive Lizenzen können upgraded werden.' });
        if ((UPGRADE_ORDER[license.type] || 0) >= (UPGRADE_ORDER[new_type] || 0))
            return res.status(400).json({
                success: false,
                message: 'Downgrade nicht erlaubt. Bitte wende dich an den Support.',
            });

        const plan = PLAN_DEFINITIONS[new_type];
        const newExpiry = toDbDate(new Date(Date.now() + plan.expires_days * 86400000));

        db.query(
            'UPDATE licenses SET type = ?, expires_at = ?, expiry_notified_at = NULL WHERE license_key = ?',
            [new_type, newExpiry, key]
        );

        let invoiceId = null;
        try {
            invoiceId = createInvoiceFromLicense(
                key,
                req.customer.portal_username || req.customer.email
            );
        } catch (invErr) {
            console.error('[Portal/upgrade] Auto-Rechnung fehlgeschlagen:', invErr.message);
        }

        await addAuditLog('portal_license_upgraded', {
            license_key: key,
            customer_id: req.customer.id,
            old_type: license.type,
            new_type,
            invoice_id: invoiceId,
        });

        const [[updated]] = db.query('SELECT * FROM licenses WHERE license_key = ?', [key]);
        res.json({ success: true, license: updated, invoice_created: !!invoiceId });
    })
);

// ── GET /stats ────────────────────────────────────────────────────────────────
router.get(
    '/stats',
    requirePortalAuth,
    asyncHandler(async (req, res) => {
        const [licenses] = db.query(
            `SELECT license_key, type, status, usage_count, max_devices, analytics_features
         FROM licenses WHERE customer_id = ? AND status = 'active'`,
            [req.customer.id]
        );

        let totalValidations = 0,
            totalDevices = 0;
        const featureCounts = {};

        for (const lic of licenses) {
            totalValidations += lic.usage_count || 0;
            try {
                const features = JSON.parse(lic.analytics_features || '{}');
                for (const [name, count] of Object.entries(features))
                    featureCounts[name] = (featureCounts[name] || 0) + (count || 0);
            } catch {
                /* analytics_features ist kein gültiges JSON – Lizenz überspringen */
            }
            try {
                const [[{ cnt }]] = db.query(
                    'SELECT COUNT(*) AS cnt FROM license_devices WHERE license_key = ?',
                    [lic.license_key]
                );
                totalDevices += cnt || 0;
            } catch {
                /* Geräteanzahl optional – bei Fehler nicht mitzählen */
            }
        }

        const topFeatures = Object.entries(featureCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name, count]) => ({ name, count }));

        res.json({
            success: true,
            stats: {
                total_validations: totalValidations,
                active_devices: totalDevices,
                active_licenses: licenses.length,
                top_features: topFeatures,
            },
        });
    })
);

// ── PATCH /licenses/:key/domain ───────────────────────────────────────────────
router.patch('/licenses/:key/domain', requirePortalAuth, async (req, res) => {
    const { domain } = req.body;
    if (!domain)
        return res.status(400).json({ success: false, message: 'Domain ist ein Pflichtfeld.' });
    const clean = normalizeDomain(domain);
    if (clean.length > 253)
        return res.status(400).json({ success: false, message: 'Domain zu lang.' });
    const labels = clean.replace(/^\*\./, '').split('.');
    const labelRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
    const valid =
        labels.length >= 2 &&
        labels.every((l) => labelRegex.test(l)) &&
        /^[a-z]{2,}$/.test(labels[labels.length - 1]);
    if (!valid)
        return res.status(400).json({
            success: false,
            message: 'Ungültige Domain. Bitte nur Hostnamen eingeben (z.B. meinrestaurant.de).',
        });
    try {
        const [rows] = db.query(
            'SELECT license_key, associated_domain FROM licenses WHERE license_key=? AND customer_id=?',
            [req.params.key, req.customer.id]
        );
        if (!rows[0])
            return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden.' });
        db.query('UPDATE licenses SET associated_domain=? WHERE license_key=? AND customer_id=?', [
            clean,
            req.params.key,
            req.customer.id,
        ]);
        res.json({
            success: true,
            domain: clean,
            message: `Domain erfolgreich auf ${clean} gesetzt.`,
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fehler beim Setzen der Domain.' });
    }
});

// ── GET /history ──────────────────────────────────────────────────────────────
router.get('/history', requirePortalAuth, async (req, res) => {
    try {
        const [history] = db.query(
            `SELECT ph.id, ph.license_key, ph.plan, ph.action, ph.amount, ph.note, ph.created_at
             FROM purchase_history ph WHERE ph.customer_id=? ORDER BY ph.created_at DESC LIMIT 200`,
            [req.customer.id]
        );
        res.json({ success: true, history });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fehler beim Laden der Kaufhistorie.' });
    }
});

// ── POST /change-password ─────────────────────────────────────────────────────
router.post('/change-password', requirePortalAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password)
        return res
            .status(400)
            .json({ success: false, message: 'Aktuelles und neues Passwort erforderlich.' });
    if (new_password.length < 10)
        return res
            .status(400)
            .json({ success: false, message: 'Neues Passwort muss mindestens 10 Zeichen haben.' });
    if (current_password === new_password)
        return res.status(400).json({
            success: false,
            message: 'Neues Passwort muss sich vom aktuellen unterscheiden.',
        });
    try {
        if (!(await bcrypt.compare(current_password, req.customer.password_hash)))
            return res
                .status(401)
                .json({ success: false, message: 'Aktuelles Passwort ist falsch.' });
        const hash = await bcrypt.hash(new_password, 12);
        db.query('UPDATE customers SET password_hash=?, must_change_password=0 WHERE id=?', [
            hash,
            req.customer.id,
        ]);
        res.json({ success: true, message: 'Passwort erfolgreich geändert.' });
    } catch (e) {
        console.error('[Portal/change-password]', e.message);
        res.status(500).json({ success: false, message: 'Interner Fehler.' });
    }
});

// ── POST /setup-password ────────────────────────────────────────────────────
router.post('/setup-password', inviteLimiter, async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password)
        return res
            .status(400)
            .json({ success: false, message: 'Token und Passwort erforderlich.' });
    if (password.length < 10)
        return res
            .status(400)
            .json({ success: false, message: 'Passwort muss mindestens 10 Zeichen haben.' });
    try {
        const [rows] = db.query(
            `SELECT * FROM customers WHERE portal_token=? AND portal_token_expires > datetime('now')`,
            [token]
        );
        if (!rows[0])
            return res.status(400).json({
                success: false,
                message: 'Link ungültig oder abgelaufen. Bitte einen neuen Link anfordern.',
            });
        const hash = await bcrypt.hash(password, 12);
        db.query(
            `UPDATE customers SET password_hash=?, portal_token=NULL, portal_token_expires=NULL, must_change_password=0 WHERE id=?`,
            [hash, rows[0].id]
        );
        res.json({
            success: true,
            message: 'Passwort erfolgreich gesetzt. Du kannst dich jetzt einloggen.',
        });
    } catch (e) {
        console.error('[Portal/setup-password]', e.message);
        res.status(500).json({ success: false, message: 'Interner Fehler.' });
    }
});

// ── GET /verify-invite-token ──────────────────────────────────────────────────
router.get('/verify-invite-token', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, message: 'Token fehlt.' });
    try {
        const [rows] = db.query(
            `SELECT id, name, email FROM customers WHERE portal_token=? AND portal_token_expires > datetime('now')`,
            [token]
        );
        if (!rows[0])
            return res
                .status(400)
                .json({ success: false, message: 'Token ungültig oder abgelaufen.' });
        res.json({ success: true, name: rows[0].name, email: rows[0].email });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Interner Fehler.' });
    }
});

// ── GET /invoices ─────────────────────────────────────────────────────────────
router.get('/invoices', requirePortalAuth, async (req, res) => {
    try {
        const [rows] = db.query(
            `SELECT i.*, c.name AS customer_name, c.company AS customer_company
             FROM invoices i LEFT JOIN customers c ON i.customer_id=c.id
             WHERE i.customer_id=? ORDER BY i.created_at DESC`,
            [req.customer.id]
        );
        res.json({ success: true, invoices: rows });
    } catch (e) {
        console.error('[Portal/invoices] Error:', e.message);
        res.status(500).json({ success: false, message: 'Fehler beim Laden der Rechnungen.' });
    }
});

// ── GET /invoices/:id/pdf ─────────────────────────────────────────────────────
router.get('/invoices/:id/pdf', requirePortalAuth, async (req, res) => {
    try {
        const invoice = getInvoiceWithItems(req.params.id);
        if (!invoice)
            return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });
        if (invoice.customer_id !== req.customer.id)
            return res.status(403).json({ success: false, message: 'Zugriff verweigert.' });

        const filename = `Rechnung-${invoice.invoice_number}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        if (invoice.pdf_path && fs.existsSync(invoice.pdf_path)) {
            fs.createReadStream(invoice.pdf_path).pipe(res);
        } else {
            const [[settings]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
            res.send(await getInvoicePDFBuffer({ ...settings, ...invoice }));
        }
    } catch (e) {
        console.error('[Portal/invoices/pdf] Error:', e.message);
        res.status(500).json({ success: false, message: 'Fehler beim Abrufen des PDF-Dokuments.' });
    }
});

// ── POST /register ────────────────────────────────────────────────────────────
router.post(
    '/register',
    registerLimiter,
    asyncHandler(async (req, res) => {
        const {
            name,
            email,
            password,
            company,
            phone,
            billing_street,
            billing_city,
            billing_zip,
            billing_country,
            tax_id,
        } = req.body;
        if (!name || typeof name !== 'string' || name.trim().length < 2)
            return res
                .status(400)
                .json({ success: false, message: 'Name muss mindestens 2 Zeichen lang sein.' });
        if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            return res.status(400).json({ success: false, message: 'Ungültige E-Mail-Adresse.' });
        if (!password || typeof password !== 'string' || password.length < 10)
            return res.status(400).json({
                success: false,
                message: 'Passwort muss mindestens 10 Zeichen lang sein.',
            });
        if (billing_zip !== undefined && billing_zip !== null) {
            const zipStr = String(billing_zip).trim();
            if (zipStr.length > 10 || (zipStr.length > 0 && !/^[a-zA-Z0-9]+$/.test(zipStr)))
                return res
                    .status(400)
                    .json({ success: false, message: 'Postleitzahl ist ungültig.' });
        }
        if (billing_country !== undefined && billing_country !== null) {
            if (!/^[a-zA-Z]{2}$/.test(String(billing_country).trim()))
                return res.status(400).json({
                    success: false,
                    message: 'Ungültiges Land (2-stelliger ISO-Code erforderlich).',
                });
        }

        const emailClean = email.toLowerCase().trim();
        const [existing] = db.query('SELECT id FROM customers WHERE email=?', [emailClean]);
        if (existing[0])
            return res
                .status(409)
                .json({ success: false, message: 'Diese E-Mail-Adresse wird bereits verwendet.' });

        const hash = await bcrypt.hash(password, 12);
        const customerId = crypto.randomUUID();
        const username = uniquePortalUsername(name, company);
        const token = crypto.randomBytes(32).toString('hex');
        const tokenExpires = toDbDate(new Date(Date.now() + 24 * 60 * 60 * 1000));

        db.query(
            `INSERT INTO customers (id, name, email, portal_username, password_hash, must_change_password,
          verified, email_verify_token, email_verify_expires,
          company, phone, billing_street, billing_city, billing_zip, billing_country, tax_id, payment_status)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')`,
            [
                customerId,
                name.trim(),
                emailClean,
                username,
                hash,
                token,
                tokenExpires,
                company ? company.trim() : null,
                phone ? String(phone).trim() : null,
                billing_street ? billing_street.trim() : null,
                billing_city ? billing_city.trim() : null,
                billing_zip ? String(billing_zip).trim() : null,
                billing_country ? String(billing_country).trim().toUpperCase() : null,
                tax_id ? tax_id.trim() : null,
            ]
        );

        const portalUrl = (process.env.PORTAL_URL || 'https://licens.stb-srv.de').replace(
            /\/$/,
            ''
        );
        await sendTemplateMail('emailVerification', emailClean, {
            name: name.trim(),
            verify_url: `${portalUrl}/portal.html#verify?token=${token}`,
            email: emailClean,
        });
        await addAuditLog(
            'customer_self_registered',
            { email: emailClean, company: company ? company.trim() : null },
            name.trim()
        );
        res.json({
            success: true,
            message: 'Registrierung erfolgreich. Bitte prüfe deine E-Mails.',
        });
    })
);

// ── POST /verify-email ────────────────────────────────────────────────────────
router.post(
    '/verify-email',
    verifyLimiter,
    asyncHandler(async (req, res) => {
        const { token } = req.body;
        if (!token)
            return res.status(400).json({ success: false, message: 'Token ist erforderlich.' });
        const [rows] = db.query(
            `SELECT id FROM customers WHERE email_verify_token=? AND email_verify_expires > datetime('now')`,
            [token]
        );
        if (!rows[0])
            return res
                .status(400)
                .json({ success: false, message: 'Ungültiger oder abgelaufener Link.' });
        db.query(
            'UPDATE customers SET verified=1, email_verify_token=NULL, email_verify_expires=NULL WHERE id=?',
            [rows[0].id]
        );
        res.json({ success: true, message: 'E-Mail bestätigt. Du kannst dich jetzt einloggen.' });
    })
);

// ── POST /forgot-password ──────────────────────────────────────────────────
router.post(
    '/forgot-password',
    registerLimiter,
    asyncHandler(async (req, res) => {
        const { email } = req.body;
        if (!email)
            return res.status(400).json({ success: false, message: 'E-Mail erforderlich.' });
        res.json({
            success: true,
            message: 'Falls ein Account existiert, wurde eine Reset-Mail gesendet.',
        });
        try {
            const [[customer]] = db.query(
                'SELECT id, name, email FROM customers WHERE email=? AND (archived IS NULL OR archived=0)',
                [email.toLowerCase().trim()]
            );
            if (!customer) return;
            const resetToken = crypto.randomBytes(32).toString('hex');
            const expires = toDbDate(new Date(Date.now() + 60 * 60 * 1000));
            db.query('UPDATE customers SET portal_token=?, portal_token_expires=? WHERE id=?', [
                resetToken,
                expires,
                customer.id,
            ]);
            const portalUrl = (process.env.PORTAL_URL || 'https://licens.stb-srv.de').replace(
                /\/$/,
                ''
            );
            await sendTemplateMail('passwordReset', customer.email, {
                name: customer.name,
                reset_url: `${portalUrl}/login.html?reset=${resetToken}`,
            });
        } catch (e) {
            console.error('[Portal/forgot-password]', e.message);
        }
    })
);

// ── GET /plans (aus DB) ───────────────────────────────────────────────────────
// ── POST /licenses/:key/renew ─────────────────────────────────────────────────
router.post(
    '/licenses/:key/renew',
    requirePortalAuth,
    asyncHandler(async (req, res) => {
        const key = req.params.key;
        const [rows] = db.query(
            'SELECT * FROM licenses WHERE license_key = ? AND customer_id = ?',
            [key, req.customer.id]
        );
        if (!rows.length)
            return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden.' });
        const lic = rows[0];
        if (!['active', 'expired'].includes(lic.status))
            return res.status(400).json({
                success: false,
                message: `Lizenz im Status "${lic.status}" kann nicht verlängert werden.`,
            });
        const plan = PLAN_DEFINITIONS[lic.type];
        if (!plan) return res.status(400).json({ success: false, message: 'Unbekannter Plantyp.' });

        const base =
            lic.status === 'active' && lic.expires_at ? new Date(lic.expires_at) : new Date();
        const newExpiry = toDbDate(new Date(base.getTime() + plan.expires_days * 86400000));

        db.query(
            `UPDATE licenses SET expires_at = ?, status = 'active', expiry_notified_at = NULL, expiry_notified_7d_at = NULL WHERE license_key = ?`,
            [newExpiry, key]
        );

        let invoiceId = null;
        if (lic.type !== 'FREE' && lic.type !== 'TRIAL') {
            try {
                invoiceId = createInvoiceFromLicense(
                    key,
                    req.customer.portal_username || req.customer.email
                );
            } catch (invErr) {
                console.error(
                    '[Portal/renew] Rechnung konnte nicht erstellt werden:',
                    invErr.message
                );
            }
        }

        await addAuditLog(
            'license_renewed_by_customer',
            {
                license_key: key,
                new_expiry: newExpiry,
                invoice_id: invoiceId,
                customer_id: req.customer.id,
            },
            req.customer.name
        );
        res.json({ success: true, license_key: key, new_expiry: newExpiry, invoice_id: invoiceId });
    })
);

router.get(
    '/plans',
    asyncHandler(async (req, res) => {
        const [rows] = db.query(
            'SELECT * FROM plan_pricing WHERE active = 1 ORDER BY sort_order ASC'
        );
        res.json({
            success: true,
            plans: rows.map((p) => ({ ...p, features: parseJsonField(p.features, []) })),
        });
    })
);

// ── POST /licenses/book ───────────────────────────────────────────────────────
router.post(
    '/licenses/book',
    requirePortalAuth,
    asyncHandler(async (req, res) => {
        const { plan_id, domain } = req.body;
        if (req.customer.verified !== 1)
            return res
                .status(403)
                .json({ success: false, message: 'Bitte bestätige zuerst deine E-Mail-Adresse.' });
        if (!plan_id || !PLAN_DEFINITIONS[plan_id])
            return res
                .status(400)
                .json({ success: false, message: 'Ungültiger oder fehlender Lizenzplan.' });

        let domainClean = null;
        if (domain) {
            domainClean = normalizeDomain(domain);
            if (!domainClean || domainClean.length > 253)
                return res.status(400).json({ success: false, message: 'Domain zu lang.' });
            const labels = domainClean.replace(/^\*\./, '').split('.');
            const labelRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
            if (
                !(
                    labels.length >= 2 &&
                    labels.every((l) => labelRegex.test(l)) &&
                    /^[a-z]{2,}$/.test(labels[labels.length - 1])
                )
            )
                return res.status(400).json({ success: false, message: 'Ungültige Domain.' });
        }

        const key = generateKey(plan_id);
        const plan = PLAN_DEFINITIONS[plan_id];
        const expiresAt = toDbDate(new Date(Date.now() + plan.expires_days * 86400000));

        db.query(
            `INSERT INTO licenses (license_key, type, customer_id, customer_name, status, associated_domain,
          expires_at, allowed_modules, limits, max_devices, analytics_daily, analytics_features, validated_domains, tags)
         VALUES (?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, 0, '{}', '{}', '[]', '[]')`,
            [
                key,
                plan_id,
                req.customer.id,
                req.customer.name,
                domainClean,
                expiresAt,
                JSON.stringify(plan.modules),
                JSON.stringify({ max_dishes: plan.menu_items, max_tables: plan.max_tables }),
            ]
        );

        const invoiceId = createInvoice(key, 'customer');
        await addAuditLog(
            'license_booked_by_customer',
            { license_key: key, plan_id, customer_id: req.customer.id },
            req.customer.name
        );
        res.json({
            success: true,
            license_key: key,
            invoice_id: invoiceId,
            message: 'Lizenz reserviert. Nach Zahlungseingang wird sie aktiviert.',
        });
    })
);

// ── Online-Zahlung (Mollie) ───────────────────────────────────────────────────
router.post(
    '/invoices/:id/checkout',
    requirePortalAuth,
    asyncHandler(async (req, res) => {
        const { isPaymentConfigured, createMolliePayment } = await import('../payment.js');
        if (!isPaymentConfigured())
            return res
                .status(503)
                .json({ success: false, message: 'Online-Zahlung ist nicht konfiguriert.' });

        const [[invoice]] = db.query(
            "SELECT * FROM invoices WHERE id = ? AND customer_id = ? AND status NOT IN ('paid','cancelled')",
            [req.params.id, req.customer.id]
        );
        if (!invoice)
            return res
                .status(404)
                .json({ success: false, message: 'Rechnung nicht gefunden oder bereits bezahlt.' });

        const appUrl = (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
        const molliePayment = await createMolliePayment({
            amount: invoice.amount_gross,
            description: `Rechnung ${invoice.invoice_number} – ${req.customer.name}`,
            redirectUrl: `${appUrl}/portal.html?tab=invoices&paid=1`,
            webhookUrl: `${appUrl}/api/v1/payment/webhook`,
            metadata: { invoice_id: invoice.id, customer_id: req.customer.id },
        });

        db.query('UPDATE invoices SET payment_id = ? WHERE id = ?', [molliePayment.id, invoice.id]);
        await addAuditLog('checkout_initiated', {
            invoice_id: invoice.id,
            payment_id: molliePayment.id,
            customer_id: req.customer.id,
        });
        res.json({
            success: true,
            checkout_url: molliePayment._links.checkout.href,
            payment_id: molliePayment.id,
        });
    })
);

// ── DSGVO / GDPR ─────────────────────────────────────────────────────────────
router.get(
    '/gdpr/export',
    requirePortalAuth,
    asyncHandler(async (req, res) => {
        const customerId = req.customer.id;
        const [[customer]] = db.query(
            'SELECT id, email, name, company, created_at FROM customers WHERE id = ?',
            [customerId]
        );
        const [licenses] = db.query(
            'SELECT license_key, type, status, expires_at, associated_domain, created_at FROM licenses WHERE customer_id = ?',
            [customerId]
        );
        const [invoices] = db.query(
            'SELECT id, amount_gross, status, created_at FROM invoices WHERE customer_id = ?',
            [customerId]
        );

        await addAuditLog('gdpr_export', { customer_id: customerId });
        res.setHeader('Content-Disposition', 'attachment; filename="meine-daten.json"');
        res.json({ exported_at: new Date().toISOString(), customer, licenses, invoices });
    })
);

router.post(
    '/gdpr/delete-request',
    requirePortalAuth,
    asyncHandler(async (req, res) => {
        const customerId = req.customer.id;
        const [[existing]] = db.query(
            "SELECT id FROM deletion_requests WHERE customer_id = ? AND status = 'pending'",
            [customerId]
        );
        if (existing)
            return res
                .status(409)
                .json({ success: false, message: 'Es gibt bereits einen offenen Löschantrag.' });

        const id = crypto.randomUUID();
        db.query('INSERT INTO deletion_requests (id, customer_id, reason) VALUES (?, ?, ?)', [
            id,
            customerId,
            req.body.reason || null,
        ]);
        await addAuditLog('gdpr_deletion_requested', { customer_id: customerId, request_id: id });
        res.json({
            success: true,
            request_id: id,
            message: 'Löschantrag eingereicht. Sie werden per E-Mail informiert.',
        });
    })
);

export default router;
