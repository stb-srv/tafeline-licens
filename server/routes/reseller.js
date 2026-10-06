import { Router } from 'express';
import db from '../db.js';
import { asyncHandler, addAuditLog, normalizeDomain } from '../helpers.js';
import { fireWebhook } from '../webhook.js';
import { sendTemplateMail } from '../mailer/index.js';
import { PLAN_DEFINITIONS } from '../plans.js';
import crypto from 'crypto';
import logger from '../logger.js';

const router = Router();

function toDbDate(d) {
    return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}

async function requireResellerKey(req, res, next) {
    const apiKey = req.headers['x-reseller-key'];
    if (!apiKey)
        return res.status(401).json({ success: false, message: 'x-reseller-key Header fehlt.' });
    const [rows] = db.query('SELECT * FROM reseller_keys WHERE api_key=? AND active=1', [apiKey]);
    if (!rows[0])
        return res
            .status(403)
            .json({ success: false, message: 'Ungültiger oder inaktiver Reseller-Key.' });
    if (rows[0].used_trials >= rows[0].max_trials)
        return res.status(429).json({
            success: false,
            message: `Trial-Kontingent erschöpft (${rows[0].max_trials} max).`,
        });
    req.reseller = rows[0];
    next();
}

router.post(
    '/trial',
    requireResellerKey,
    asyncHandler(async (req, res) => {
        const { domain: rawDomain, restaurant_name, contact_email } = req.body;
        if (!rawDomain) return res.status(400).json({ success: false, message: 'domain fehlt.' });
        const domain = normalizeDomain(rawDomain) || rawDomain;

        const [existing] = db.query(
            "SELECT license_key FROM licenses WHERE associated_domain=? AND type='TRIAL' AND status='active'",
            [domain]
        );
        if (existing[0])
            return res.status(409).json({
                success: false,
                message: 'Bereits ein aktiver Trial für diese Domain.',
                license_key: existing[0].license_key,
            });

        const plan = PLAN_DEFINITIONS['TRIAL'];
        const key =
            'TAFELINE-' +
            crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{4}/g).join('-');
        const expiresAt = toDbDate(new Date(Date.now() + plan.expires_days * 24 * 60 * 60 * 1000));
        const notes = JSON.stringify({
            contact_email,
            reseller: req.reseller.name,
            source: 'reseller_api',
        });

        db.query(
            `INSERT INTO licenses (license_key, customer_name, associated_domain, type, status, expires_at, notes, reseller_id, created_at)
         VALUES (?, ?, ?, 'TRIAL', 'active', ?, ?, ?, datetime('now'))`,
            [key, restaurant_name || domain, domain, expiresAt, notes, req.reseller.id]
        );
        db.query('UPDATE reseller_keys SET used_trials=used_trials+1 WHERE id=?', [
            req.reseller.id,
        ]);

        await addAuditLog('reseller_trial_issued', {
            license_key: key,
            domain,
            reseller: req.reseller.name,
            contact_email,
        });
        await fireWebhook('trial.registered', {
            license_key: key,
            domain,
            restaurant_name,
            contact_email,
            source: `reseller:${req.reseller.name}`,
        });

        if (contact_email) {
            try {
                await sendTemplateMail('trialWelcome', contact_email, {
                    restaurant_name: restaurant_name || domain,
                    license_key: key,
                    expires_at: expiresAt,
                    domain,
                    plan_label: plan.label,
                    limits: { max_dishes: plan.menu_items, max_tables: plan.max_tables },
                });
            } catch (e) {
                logger.warn({ err: e }, 'Reseller Welcome-Mail fehlgeschlagen:');
            }
        }

        return res.status(201).json({
            success: true,
            license_key: key,
            expires_at: expiresAt,
            reseller: req.reseller.name,
            remaining_trials: req.reseller.max_trials - req.reseller.used_trials - 1,
        });
    })
);

router.get(
    '/licenses',
    requireResellerKey,
    asyncHandler(async (req, res) => {
        const [rows] = db.query(
            `SELECT license_key, customer_name, associated_domain AS domain, type, status, expires_at, created_at
         FROM licenses WHERE reseller_id=? ORDER BY created_at DESC`,
            [req.reseller.id]
        );
        return res.json({ success: true, licenses: rows, reseller: req.reseller.name });
    })
);

export default router;
