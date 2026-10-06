import { Router } from 'express';
import crypto from 'crypto';
import db from '../../db.js';
import { PLAN_DEFINITIONS } from '../../plans.js';
import { getClientIp, addAuditLog, normalizeDomain } from '../../helpers.js';
import { fireWebhook } from '../../webhook.js';
import { sendTemplateMail } from '../../mailer/index.js';
import { setupLimiter, trialLimiter, MIN_PASSWORD_LENGTH, asyncHandler } from '../../middleware.js';
import logger from '../../logger.js';
import { SETUP_TOKEN, toDbDate } from './shared.js';

const router = Router();

// ── Setup Status ──────────────────────────────────────────────────────────────
router.get(
    '/setup-status',
    asyncHandler(async (req, res) => {
        const [[{ count }]] = db.query('SELECT COUNT(*) as count FROM admins');
        if (count > 0) return res.json({ needed: false });
        res.json({ needed: true, setup_token: process.env.SETUP_TOKEN || null });
    })
);

// ── Setup ─────────────────────────────────────────────────────────────────────
router.post(
    '/setup',
    setupLimiter,
    asyncHandler(async (req, res) => {
        if (!SETUP_TOKEN)
            return res.status(503).json({
                success: false,
                message: 'Setup ist deaktiviert. SETUP_TOKEN nicht in .env konfiguriert.',
            });

        const providedToken = req.headers['x-setup-token'] || req.body?.setup_token;
        if (!providedToken || providedToken !== SETUP_TOKEN) {
            await addAuditLog('setup_attempt_failed', {
                reason: 'invalid_token',
                ip: getClientIp(req),
            });
            return res.status(401).json({ success: false, message: 'Ungültiger Setup-Token.' });
        }

        const { username, password } = req.body;
        if (!username || !password)
            return res
                .status(400)
                .json({ success: false, message: 'Username und Passwort sind Pflichtfelder.' });
        if (password.length < MIN_PASSWORD_LENGTH)
            return res.status(400).json({
                success: false,
                message: `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`,
            });

        try {
            const [[{ count }]] = db.query('SELECT COUNT(*) as count FROM admins');
            if (count > 0)
                return res.status(409).json({
                    success: false,
                    message: 'Setup bereits abgeschlossen. Admin-Account existiert bereits.',
                });

            const { default: bcrypt } = await import('bcryptjs');
            const hash = await bcrypt.hash(password, 12);
            db.query('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', [
                username,
                hash,
                'superadmin',
            ]);
            await addAuditLog('setup_completed', { username, ip: getClientIp(req) });
            logger.info({ username }, 'Setup abgeschlossen');
            res.json({
                success: true,
                message: `Superadmin '${username}' erfolgreich erstellt. SETUP_TOKEN kann jetzt aus .env entfernt werden.`,
            });
        } catch (e) {
            logger.error({ err: e }, 'Setup-Fehler');
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    })
);

// ── Trial Self-Registration ────────────────────────────────────────────────────
router.post(
    '/trial/register',
    trialLimiter,
    asyncHandler(async (req, res) => {
        const { domain: rawDomain, contact_email, restaurant_name, instance_id } = req.body;
        if (!rawDomain)
            return res.status(400).json({ success: false, message: 'Domain ist Pflichtfeld.' });

        const domain = normalizeDomain(rawDomain) || rawDomain;
        const clientIp = getClientIp(req);

        const [existing] = db.query(
            "SELECT license_key FROM licenses WHERE associated_domain = ? AND type = 'TRIAL'",
            [domain]
        );
        if (existing.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Für diese Domain ist bereits ein Trial aktiv.',
                hint: 'Bitte nutzen Sie Ihren bestehenden Trial-Key oder kontaktieren Sie den Support.',
            });
        }

        const key = `TAFELINE-TRIAL-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const expiresAt = toDbDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

        const notes = JSON.stringify({
            contact_email: contact_email || null,
            instance_id: instance_id || null,
            registered_ip: clientIp,
            registered_at: new Date().toISOString(),
            source: 'self-registration',
        });

        db.query(
            `INSERT INTO licenses (license_key, type, status, customer_name, associated_domain, expires_at, notes, max_devices)
         VALUES (?, 'TRIAL', 'active', ?, ?, ?, ?, 1)`,
            [key, restaurant_name || domain, domain, expiresAt, notes]
        );

        await addAuditLog('trial_registered', {
            license_key: key,
            domain,
            contact_email: contact_email || null,
            restaurant_name: restaurant_name || null,
            instance_id: instance_id || null,
            ip: clientIp,
        });

        const plan = PLAN_DEFINITIONS['TRIAL'];
        await fireWebhook('trial.registered', {
            license_key: key,
            domain,
            restaurant_name: restaurant_name || domain,
            contact_email: contact_email || null,
            expires_at: expiresAt,
            registered_ip: clientIp,
        });

        if (contact_email) {
            try {
                await sendTemplateMail('trialWelcome', contact_email, {
                    restaurant_name: restaurant_name || domain,
                    license_key: key,
                    expires_at: expiresAt,
                    domain,
                    plan_label: plan.label,
                    modules: plan.modules,
                    limits: { max_dishes: plan.menu_items, max_tables: plan.max_tables },
                });
            } catch (mailErr) {
                logger.warn({ err: mailErr }, 'Willkommens-Mail fehlgeschlagen');
            }
        }

        return res.status(201).json({
            success: true,
            license_key: key,
            plan: 'TRIAL',
            plan_label: plan.label,
            expires_at: expiresAt,
            modules: plan.modules,
            limits: { max_dishes: plan.menu_items, max_tables: plan.max_tables },
            message: `Ihr 30-Tage Trial wurde aktiviert. Key: ${key}`,
        });
    })
);

export default router;
