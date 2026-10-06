import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { PLAN_DEFINITIONS } from '../plans.js';
import { sendTemplateMail } from '../mailer/index.js';
import { fireWebhook } from '../webhook.js';
import { addAuditLog } from '../helpers.js';
import { requireAuth, asyncHandler } from '../middleware.js';
import { createInvoiceFromLicense } from '../invoiceHelper.js';

const router = Router();

// ── Devices ──────────────────────────────────────────────────────────────────
router.get(
    '/devices',
    requireAuth,
    asyncHandler(async (req, res) => {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
        const offset = (page - 1) * limit;
        const { license_key, search } = req.query;

        let where = '1=1';
        const params = [];
        if (license_key) {
            where += ' AND license_key = ?';
            params.push(license_key);
        }
        if (search) {
            const s = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
            where += ` AND (device_id LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\' OR device_type LIKE ? ESCAPE '\\' OR license_key LIKE ? ESCAPE '\\')`;
            params.push(s, s, s, s);
        }

        const [[{ total }]] = db.query(
            `SELECT COUNT(*) as total FROM devices WHERE ${where}`,
            params
        );
        const [devices] = db.query(
            `SELECT * FROM devices WHERE ${where} ORDER BY last_seen DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        res.json({
            devices,
            pagination: { page, limit, total: parseInt(total), pages: Math.ceil(total / limit) },
        });
    })
);

router.patch(
    '/devices/:id/deactivate',
    requireAuth,
    asyncHandler(async (req, res) => {
        try {
            const [rows] = db.query('SELECT * FROM devices WHERE id = ?', [req.params.id]);
            if (!rows[0]) return res.status(404).json({ success: false });
            db.query(
                `UPDATE devices SET active = 0, deactivated_at = datetime('now') WHERE id = ?`,
                [req.params.id]
            );
            await addAuditLog(
                'device_deactivated',
                {
                    device_id: rows[0].device_id,
                    license_key: rows[0].license_key,
                    by: req.admin.username,
                },
                req.admin.username
            );
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    })
);

router.delete(
    '/devices/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
        try {
            const [rows] = db.query('SELECT * FROM devices WHERE id = ?', [req.params.id]);
            if (!rows[0]) return res.status(404).json({ success: false });
            db.query('DELETE FROM devices WHERE id = ?', [req.params.id]);
            await addAuditLog(
                'device_removed',
                {
                    device_id: rows[0].device_id,
                    license_key: rows[0].license_key,
                    by: req.admin.username,
                },
                req.admin.username
            );
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    })
);

// ── Reseller ────────────────────────────────────────────────────────────────��
router.get(
    '/resellers',
    requireAuth,
    asyncHandler(async (req, res) => {
        const [rows] = db.query('SELECT * FROM reseller_keys ORDER BY created_at DESC');
        return res.json({ success: true, resellers: rows });
    })
);

router.post(
    '/resellers',
    requireAuth,
    asyncHandler(async (req, res) => {
        const { name, email, max_trials = 10, notes } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'name fehlt.' });
        const apiKey = 'RSL-' + crypto.randomBytes(16).toString('hex').toUpperCase();
        db.query(
            'INSERT INTO reseller_keys (api_key, name, email, max_trials, notes) VALUES (?,?,?,?,?)',
            [apiKey, name, email, max_trials, notes]
        );
        await addAuditLog('reseller_created', { name, email, max_trials }, req.admin.username);
        return res.status(201).json({ success: true, api_key: apiKey, name, max_trials });
    })
);

router.patch(
    '/resellers/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
        const { max_trials, active, notes } = req.body;
        db.query(
            'UPDATE reseller_keys SET max_trials = COALESCE(?,max_trials), active = COALESCE(?,active), notes = COALESCE(?,notes) WHERE id = ?',
            [max_trials, active, notes, req.params.id]
        );
        await addAuditLog(
            'reseller_updated',
            { reseller_id: req.params.id, max_trials, active },
            req.admin.username
        );
        return res.json({ success: true });
    })
);

export default router;
