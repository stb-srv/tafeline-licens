import { Router } from 'express';
import db from '../../db.js';
import { createInvoice, createInvoiceFromLicense } from '../../invoiceHelper.js';
import { PLAN_DEFINITIONS } from '../../plans.js';
import {
    generateKey,
    addAuditLog,
    asyncHandler,
    normalizeDomain,
    parseJsonField,
} from '../../helpers.js';
import { toDbDate, requirePortalAuth } from './shared.js';
import logger from '../../logger.js';

const router = Router();

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
            logger.error({ err: invErr }, '[Portal/upgrade] Auto-Rechnung fehlgeschlagen:');
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
                logger.error(
                    { err: invErr },
                    '[Portal/renew] Rechnung konnte nicht erstellt werden:'
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
            if (!(
                labels.length >= 2 &&
                labels.every((l) => labelRegex.test(l)) &&
                /^[a-z]{2,}$/.test(labels[labels.length - 1])
            ))
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

export default router;
