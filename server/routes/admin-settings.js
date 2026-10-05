import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from '../db.js';
import { buildTransporter, sendTemplateMail, getActiveSmtpConfig } from '../mailer/index.js';
import { PLAN_DEFINITIONS } from '../plans.js';
import { addAuditLog } from '../helpers.js';
import {
    requireAuth,
    requireSuperAdmin,
    asyncHandler,
    MIN_PASSWORD_LENGTH,
} from '../middleware.js';
import { generateKeyPair, getAllJwks } from '../crypto.js';
import { retryDeadLetter } from '../webhook.js';

const router = Router();

// ── Plans ────────────────────────────────────────────────────────────────────
router.get('/plans', requireAuth, (req, res) => res.json(PLAN_DEFINITIONS));

// ── Session-Management ────────────────────────────────────────────────────────
router.get(
    '/sessions',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const [rows] = db.query(
            `
        SELECT id, admin_username, ip, user_agent, created_at, expires_at,
               CASE WHEN token_hash = ? THEN 1 ELSE 0 END AS is_current
        FROM admin_sessions
        WHERE revoked = 0 AND expires_at > datetime('now')
        ORDER BY created_at DESC
    `,
            [req.adminTokenHash || '']
        );
        res.json({ success: true, sessions: rows });
    })
);

router.delete(
    '/sessions/:id',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const [[session]] = db.query('SELECT id, admin_username FROM admin_sessions WHERE id = ?', [
            req.params.id,
        ]);
        if (!session)
            return res.status(404).json({ success: false, message: 'Session nicht gefunden.' });
        db.query('UPDATE admin_sessions SET revoked = 1 WHERE id = ?', [req.params.id]);
        await addAuditLog('session_revoked', {
            session_id: req.params.id,
            username: session.admin_username,
            by: req.admin.username,
        });
        res.json({ success: true });
    })
);

// ── Key-Rotation / JWKS ───────────────────────────────────────────────────────
router.get(
    '/signing-keys',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const [rows] = db.query(
            'SELECT kid, status, created_at FROM signing_keys ORDER BY created_at DESC'
        );
        res.json({ success: true, keys: rows, jwks: getAllJwks() });
    })
);

router.post(
    '/rotate-keys',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const { privateKey, publicKey, kid } = generateKeyPair();
        db.runTransaction(() => {
            db.query("UPDATE signing_keys SET status = 'retired' WHERE status = 'active'");
            db.query(
                'INSERT INTO signing_keys (kid, public_key, private_key, status) VALUES (?, ?, ?, ?)',
                [kid, publicKey, privateKey, 'active']
            );
        });
        await addAuditLog('key_rotation', { kid, performed_by: req.admin?.username || 'unknown' });
        res.json({
            success: true,
            kid,
            message: 'Neuer Signing-Key aktiv. Alten Tokens bleiben bis Token-Ablauf gültig.',
        });
    })
);

// ── Admin Users ──────────────────────────────────────────────────────────────
router.get(
    '/users',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const [rows] = db.query(
            'SELECT id, username, role, active, created_at, two_factor_enabled FROM admins'
        );
        res.json({ users: rows });
    })
);

router.post(
    '/users',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const { username, password, role } = req.body;
        if (!username || !password)
            return res
                .status(400)
                .json({ success: false, message: 'Username and password required' });
        if (password.length < MIN_PASSWORD_LENGTH)
            return res.status(400).json({
                success: false,
                message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
            });
        const assignedRole = ['admin', 'superadmin'].includes(role) ? role : 'admin';
        try {
            const hash = await bcrypt.hash(password, 12);
            db.query('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', [
                username,
                hash,
                assignedRole,
            ]);
            await addAuditLog(
                'admin_user_created',
                { username, role: assignedRole, by: req.admin.username },
                req.admin.username
            );
            res.json({ success: true, user: { username, role: assignedRole } });
        } catch (e) {
            if (
                e.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
                (e.message && e.message.includes('UNIQUE'))
            )
                return res.status(409).json({ success: false, message: 'Username already exists' });
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    })
);

router.delete(
    '/users/:username',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        if (req.params.username === req.admin.username)
            return res
                .status(400)
                .json({ success: false, message: 'Cannot delete your own account' });
        try {
            const [result] = db.query('DELETE FROM admins WHERE username = ?', [
                req.params.username,
            ]);
            if (result.affectedRows === 0)
                return res.status(404).json({ success: false, message: 'User not found' });
            await addAuditLog(
                'admin_user_deleted',
                { username: req.params.username, by: req.admin.username },
                req.admin.username
            );
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    })
);

router.patch(
    '/users/:username',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const { role, active } = req.body;
        const updates = [],
            params = [];
        if (role !== undefined) {
            updates.push('role = ?');
            params.push(['admin', 'superadmin'].includes(role) ? role : 'admin');
        }
        if (active !== undefined) {
            updates.push('active = ?');
            params.push(active ? 1 : 0);
        }
        if (updates.length === 0)
            return res.status(400).json({ success: false, message: 'No fields to update' });

        params.push(req.params.username);
        db.query(`UPDATE admins SET ${updates.join(', ')} WHERE username = ?`, params);
        await addAuditLog(
            'admin_user_updated',
            {
                username: req.params.username,
                changes: Object.keys(req.body),
                by: req.admin.username,
            },
            req.admin.username
        );
        res.json({ success: true });
    })
);

router.patch(
    '/users/:username/password',
    requireAuth,
    asyncHandler(async (req, res) => {
        const isSelf = req.params.username === req.admin.username;
        const isSuperAdmin = req.admin.role === 'superadmin';
        if (!isSelf && !isSuperAdmin)
            return res.status(403).json({ success: false, message: 'Forbidden' });
        const { password } = req.body;
        if (!password || password.length < MIN_PASSWORD_LENGTH)
            return res.status(400).json({
                success: false,
                message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
            });
        try {
            const hash = await bcrypt.hash(password, 12);
            db.query('UPDATE admins SET password_hash = ? WHERE username = ?', [
                hash,
                req.params.username,
            ]);
            db.query(
                'UPDATE admin_sessions SET revoked = 1 WHERE admin_username = ? AND token_hash != ?',
                [req.params.username, req.adminTokenHash || 'none']
            );
            await addAuditLog(
                'admin_password_changed',
                { username: req.params.username, by: req.admin.username },
                req.admin.username
            );
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    })
);

// ── SMTP Config ──────────────────────────────────────────────────────────────
router.get(
    '/smtp',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        try {
            const [rows] = db.query(
                'SELECT host, port, secure, smtp_user, smtp_from FROM smtp_config WHERE id = 1'
            );
            const cfg = rows[0] || {};
            res.json({
                success: true,
                smtp: {
                    host: cfg.host || '',
                    port: cfg.port || '587',
                    secure: cfg.secure || 'false',
                    user: cfg.smtp_user || '',
                    from: cfg.smtp_from || '',
                    configured: !!(cfg.host && cfg.smtp_user),
                },
            });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    })
);

router.post(
    '/smtp',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const { host, port, secure, user, pass, from, test_to } = req.body;
        if (!host || !user || !pass)
            return res.status(400).json({
                success: false,
                message: 'Host, Benutzer und Passwort sind Pflichtfelder',
            });
        try {
            const transporter = buildTransporter({
                host,
                port: port || '587',
                secure: secure || 'false',
                user,
                pass,
            });
            await transporter.verify();
            db.query(
                `INSERT INTO smtp_config (id, host, port, secure, smtp_user, smtp_pass, smtp_from)
             VALUES (1,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               host=excluded.host, port=excluded.port, secure=excluded.secure,
               smtp_user=excluded.smtp_user, smtp_pass=excluded.smtp_pass, smtp_from=excluded.smtp_from,
               updated_at=datetime('now')`,
                [host, port || '587', secure || 'false', user, pass, from || user]
            );
            await addAuditLog(
                'smtp_config_updated',
                { host, user, by: req.admin.username },
                req.admin.username
            );
            if (test_to) {
                const { subject, html, text } = (
                    await import('../mailer/templates.js')
                ).renderTemplate('test', { host });
                await transporter.sendMail({
                    from: from || user,
                    to: test_to,
                    subject,
                    html,
                    text,
                });
                return res.json({
                    success: true,
                    message: `SMTP gespeichert und Test-Mail an ${test_to} gesendet.`,
                });
            }
            res.json({
                success: true,
                message: 'SMTP-Konfiguration gespeichert und Verbindung erfolgreich verifiziert.',
            });
        } catch (e) {
            console.error('[SMTP save]', e);
            res.status(400).json({ success: false, message: `SMTP-Fehler: ${e.message}` });
        }
    })
);

router.post(
    '/smtp/test',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const { to } = req.body;
        if (!to) return res.status(400).json({ success: false, message: 'Empfänger-E-Mail fehlt' });
        try {
            const cfg = await getActiveSmtpConfig();
            if (!cfg)
                return res
                    .status(500)
                    .json({ success: false, message: 'SMTP nicht konfiguriert.' });
            const info = await sendTemplateMail('test', to, { host: cfg.host });
            res.json({
                success: true,
                message: `Test-E-Mail an ${to} gesendet. MessageId: ${info.messageId}`,
            });
        } catch (e) {
            res.status(500).json({ success: false, message: `Fehler beim Senden: ${e.message}` });
        }
    })
);

router.delete(
    '/smtp',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        try {
            db.query('DELETE FROM smtp_config WHERE id = 1');
            await addAuditLog(
                'smtp_config_deleted',
                { by: req.admin.username },
                req.admin.username
            );
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    })
);

// ── Webhooks Config ──────────────────────────────────────────────────────────
router.get(
    '/webhooks',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const [rows] = db.query('SELECT id, url, events, active, created_at FROM webhooks');
        res.json({ webhooks: rows });
    })
);

router.post(
    '/webhooks',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const { url, secret, events } = req.body;
        if (!url) return res.status(400).json({ success: false, message: 'URL erforderlich' });
        try {
            const [result] = db.query(
                'INSERT INTO webhooks (url, secret, events) VALUES (?, ?, ?)',
                [url, secret || null, JSON.stringify(events || ['*'])]
            );
            await addAuditLog(
                'webhook_created',
                { url, by: req.admin.username },
                req.admin.username
            );
            res.json({ success: true, id: result.insertId });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    })
);

router.delete(
    '/webhooks/:id',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        try {
            db.query('DELETE FROM webhooks WHERE id = ?', [req.params.id]);
            await addAuditLog(
                'webhook_deleted',
                { webhook_id: req.params.id, by: req.admin.username },
                req.admin.username
            );
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    })
);

router.get(
    '/webhook-dead-letters',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const [rows] = db.query(
            'SELECT id, webhook_url, event, error, attempt_count, failed_at, retried_at, resolved FROM webhook_dead_letters ORDER BY failed_at DESC LIMIT 100'
        );
        res.json({ success: true, dead_letters: rows });
    })
);

router.post(
    '/webhook-dead-letters/:id/retry',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        await retryDeadLetter(req.params.id);
        await addAuditLog('webhook_dead_letter_retried', {
            id: req.params.id,
            by: req.admin.username,
        });
        res.json({ success: true, message: 'Webhook erfolgreich wiederholt.' });
    })
);

router.get('/webhooks/signing-info', requireAuth, (req, res) => {
    res.json({
        success: true,
        algorithm: 'HMAC-SHA256',
        header: 'X-TAFELINE-Signature',
        description:
            'Jeder Webhook-Request enthält den Header "X-TAFELINE-Signature" (wenn ein Secret konfiguriert ist).',
    });
});

// ── Plan-Preise ───────────────────────────────────────────────────────────────
router.get(
    '/plan-pricing',
    requireAuth,
    asyncHandler(async (req, res) => {
        const [rows] = db.query('SELECT * FROM plan_pricing ORDER BY sort_order ASC');
        res.json({ plans: rows });
    })
);

router.put(
    '/plan-pricing/:plan_id',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const { label, description, price, currency, features, active, sort_order } = req.body;
        const { plan_id } = req.params;
        const [[existing]] = db.query('SELECT plan_id FROM plan_pricing WHERE plan_id = ?', [
            plan_id,
        ]);
        const featuresJson = Array.isArray(features) ? JSON.stringify(features) : features || '[]';
        if (existing) {
            db.query(
                `UPDATE plan_pricing SET label=?, description=?, price=?, currency=?, features=?,
             active=?, sort_order=?, updated_at=datetime('now') WHERE plan_id=?`,
                [
                    label,
                    description || null,
                    parseFloat(price) || 0,
                    currency || 'EUR',
                    featuresJson,
                    active ? 1 : 0,
                    sort_order ?? 0,
                    plan_id,
                ]
            );
        } else {
            db.query(
                `INSERT INTO plan_pricing (plan_id,label,description,price,currency,features,active,sort_order)
             VALUES (?,?,?,?,?,?,?,?)`,
                [
                    plan_id,
                    label,
                    description || null,
                    parseFloat(price) || 0,
                    currency || 'EUR',
                    featuresJson,
                    active ? 1 : 0,
                    sort_order ?? 0,
                ]
            );
        }
        await addAuditLog(
            'plan_pricing_updated',
            { plan_id, by: req.admin.username },
            req.admin.username
        );
        const [[updated]] = db.query('SELECT * FROM plan_pricing WHERE plan_id = ?', [plan_id]);
        res.json({ success: true, plan: updated });
    })
);

// ── FAQ ────────────────────────────────────────────────────────────────────────
router.get(
    '/faq',
    requireAuth,
    asyncHandler(async (req, res) => {
        const [rows] = db.query('SELECT * FROM faq ORDER BY sort_order ASC, created_at ASC');
        res.json({ faq: rows });
    })
);

router.post(
    '/faq',
    requireAuth,
    asyncHandler(async (req, res) => {
        const { question, answer, category, sort_order, active } = req.body;
        if (!question || !answer)
            return res
                .status(400)
                .json({ success: false, message: 'Frage und Antwort sind Pflichtfelder.' });
        const id = crypto.randomUUID();
        db.query(
            `INSERT INTO faq (id, question, answer, category, sort_order, active) VALUES (?, ?, ?, ?, ?, ?)`,
            [
                id,
                question,
                answer,
                category || 'Allgemein',
                sort_order ?? 99,
                active !== false ? 1 : 0,
            ]
        );
        await addAuditLog('faq_created', { id, by: req.admin.username }, req.admin.username);
        const [[row]] = db.query('SELECT * FROM faq WHERE id = ?', [id]);
        res.json({ success: true, faq: row });
    })
);

router.put(
    '/faq/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
        const { question, answer, category, sort_order, active } = req.body;
        const [[existing]] = db.query('SELECT id FROM faq WHERE id = ?', [req.params.id]);
        if (!existing)
            return res.status(404).json({ success: false, message: 'FAQ nicht gefunden.' });
        db.query(
            `UPDATE faq SET question=?, answer=?, category=?, sort_order=?, active=?, updated_at=datetime('now') WHERE id=?`,
            [
                question,
                answer,
                category || 'Allgemein',
                sort_order ?? 0,
                active !== false ? 1 : 0,
                req.params.id,
            ]
        );
        await addAuditLog(
            'faq_updated',
            { id: req.params.id, by: req.admin.username },
            req.admin.username
        );
        const [[row]] = db.query('SELECT * FROM faq WHERE id = ?', [req.params.id]);
        res.json({ success: true, faq: row });
    })
);

router.delete(
    '/faq/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
        const [[existing]] = db.query('SELECT id FROM faq WHERE id = ?', [req.params.id]);
        if (!existing)
            return res.status(404).json({ success: false, message: 'FAQ nicht gefunden.' });
        db.query('DELETE FROM faq WHERE id = ?', [req.params.id]);
        await addAuditLog(
            'faq_deleted',
            { id: req.params.id, by: req.admin.username },
            req.admin.username
        );
        res.json({ success: true });
    })
);

export default router;
