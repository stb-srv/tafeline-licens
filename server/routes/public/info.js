import { Router } from 'express';
import jwt from 'jsonwebtoken';
import db from '../../db.js';
import { PLAN_DEFINITIONS } from '../../plans.js';
import { RSA_PUBLIC_KEY, getAllJwks } from '../../crypto.js';
import { addAuditLog, parseJsonField } from '../../helpers.js';
import { fireWebhook } from '../../webhook.js';
import { asyncHandler } from '../../middleware.js';

const router = Router();

// ── Public Key ───────────────────────────────────────────────────────────────────
router.get('/public-key', (req, res) =>
    res.json({ public_key: RSA_PUBLIC_KEY, algorithm: 'RS256' })
);

// ── JWKS (alle aktiven Public Keys für CMS-Verifikation) ──────────────────────
router.get('/jwks', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(getAllJwks());
});

// ── Health Check ──────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
    try {
        db.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
    } catch (e) {
        res.status(503).json({ status: 'degraded', database: 'disconnected', error: e.message });
    }
});

// ── GET /plans (öffentlich) ───────────────────────────────────────────────────
router.get(
    '/plans',
    asyncHandler(async (req, res) => {
        const [rows] = db.query(
            'SELECT * FROM plan_pricing WHERE active = 1 ORDER BY sort_order ASC'
        );
        const plans = rows.map((p) => ({
            ...p,
            features: parseJsonField(p.features, []),
            modules: PLAN_DEFINITIONS[p.plan_id]?.modules ?? null,
            menu_items: PLAN_DEFINITIONS[p.plan_id]?.menu_items ?? null,
            max_tables: PLAN_DEFINITIONS[p.plan_id]?.max_tables ?? null,
            expires_days: PLAN_DEFINITIONS[p.plan_id]?.expires_days ?? null,
        }));
        res.set('Cache-Control', 'public, max-age=300');
        res.json({ success: true, plans });
    })
);

// ── GET /licenses/:key/upgrades (License-JWT-Auth) ────────────────────────────
const UPGRADE_ORDER = { FREE: 0, TRIAL: 0, STARTER: 1, PRO: 2, PRO_PLUS: 3, ENTERPRISE: 4 };

router.get(
    '/licenses/:key/upgrades',
    asyncHandler(async (req, res) => {
        const key = req.params.key;

        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token)
            return res.status(401).json({ success: false, message: 'License-Token fehlt.' });

        let payload;
        try {
            payload = RSA_PUBLIC_KEY
                ? jwt.verify(token, RSA_PUBLIC_KEY, { algorithms: ['RS256'] })
                : jwt.verify(token, process.env.ADMIN_SECRET || '', { algorithms: ['HS256'] });
        } catch {
            return res.status(401).json({ success: false, message: 'Ungültiger License-Token.' });
        }

        if (payload.license_key !== key)
            return res
                .status(403)
                .json({ success: false, message: 'Token gehört nicht zu dieser Lizenz.' });

        const [rows] = db.query(
            "SELECT type FROM licenses WHERE license_key = ? AND status IN ('active', 'trial')",
            [key]
        );
        if (!rows.length)
            return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden.' });

        const currentType = rows[0].type;
        const currentOrder = UPGRADE_ORDER[currentType] ?? 0;

        const [pricingRows] = db.query(
            'SELECT * FROM plan_pricing WHERE active = 1 ORDER BY sort_order ASC'
        );
        const upgrades = pricingRows
            .filter((p) => (UPGRADE_ORDER[p.plan_id] ?? 0) > currentOrder)
            .map((p) => ({
                ...p,
                features: parseJsonField(p.features, []),
                modules: PLAN_DEFINITIONS[p.plan_id]?.modules ?? null,
                menu_items: PLAN_DEFINITIONS[p.plan_id]?.menu_items ?? null,
                max_tables: PLAN_DEFINITIONS[p.plan_id]?.max_tables ?? null,
                expires_days: PLAN_DEFINITIONS[p.plan_id]?.expires_days ?? null,
            }));

        res.set('Cache-Control', 'private, max-age=60');
        res.json({ success: true, current_plan: currentType, upgrades });
    })
);

// ── GET /faq (öffentlich) ─────────────────────────────────────────────────────
router.get(
    '/faq',
    asyncHandler(async (req, res) => {
        const [rows] = db.query('SELECT * FROM faq WHERE active = 1 ORDER BY sort_order ASC');
        res.json({ success: true, faq: rows });
    })
);

// ── POST /payment/webhook (Mollie) ────────────────────────────────────────────
router.post(
    '/payment/webhook',
    asyncHandler(async (req, res) => {
        const paymentId = req.body?.id;
        const { verifyMollieWebhook, getMolliePayment } = await import('../payment.js');

        if (!verifyMollieWebhook(paymentId))
            return res.status(400).json({ success: false, message: 'Ungültige Webhook-ID.' });

        let molliePayment;
        try {
            molliePayment = await getMolliePayment(paymentId);
        } catch (e) {
            return res
                .status(502)
                .json({ success: false, message: 'Mollie-Lookup fehlgeschlagen.' });
        }

        if (molliePayment.status !== 'paid')
            return res.status(200).json({ success: true, status: molliePayment.status });

        const [[invoice]] = db.query('SELECT * FROM invoices WHERE payment_id = ?', [paymentId]);
        if (!invoice)
            return res.status(200).json({ success: true, message: 'Rechnung nicht zugeordnet.' });
        if (invoice.status === 'paid')
            return res.status(200).json({ success: true, message: 'Bereits bezahlt.' });

        // Verify amount server-side — never trust client data
        const mollieAmount = parseFloat(molliePayment.amount.value);
        if (Math.abs(mollieAmount - parseFloat(invoice.amount_gross)) > 0.01)
            return res
                .status(400)
                .json({ success: false, message: 'Betrag stimmt nicht überein.' });

        db.runTransaction(() => {
            db.query("UPDATE invoices SET status='paid', paid_at=datetime('now') WHERE id=?", [
                invoice.id,
            ]);
            if (invoice.license_key) {
                const [[lic]] = db.query('SELECT * FROM licenses WHERE license_key=?', [
                    invoice.license_key,
                ]);
                if (lic) {
                    const plan = PLAN_DEFINITIONS[lic.type] || {};
                    const days = plan.expires_days || 365;
                    const expiresAt = new Date(Date.now() + days * 86400000)
                        .toISOString()
                        .slice(0, 19)
                        .replace('T', ' ');
                    db.query(
                        "UPDATE licenses SET status='active', expires_at=? WHERE license_key=?",
                        [expiresAt, invoice.license_key]
                    );
                }
            }
        });

        await addAuditLog('payment_received', {
            invoice_id: invoice.id,
            payment_id: paymentId,
            amount: mollieAmount,
        });
        await fireWebhook('invoice.paid', {
            invoice_id: invoice.id,
            license_key: invoice.license_key,
        });
        res.status(200).json({ success: true });
    })
);

export default router;
