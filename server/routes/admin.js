import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from '../db.js';
import { getClientIp, addAuditLog } from '../helpers.js';
import {
    requireAuth,
    loginLimiter,
    signAdminToken,
    asyncHandler,
    signTempToken,
} from '../middleware.js';
import * as otplibPkg from 'otplib';
const { authenticator } = otplibPkg;
import QRCode from 'qrcode';

import licensesRouter from './admin-licenses.js';
import devicesResellersRouter from './admin-devices-resellers.js';
import customersRouter from './admin-customers.js';
import settingsRouter from './admin-settings.js';
import statsRouter from './admin-stats.js';
import invoicesRouter from './admin-invoices.js';

const router = Router();

router.use(licensesRouter);
router.use(devicesResellersRouter);
router.use(customersRouter);
router.use(settingsRouter);
router.use(statsRouter);
router.use(invoicesRouter);

// ── Auth ───────────────────────────────────────────────────────────────────
router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password)
            return res
                .status(400)
                .json({ success: false, message: 'Username and password required' });

        const [rows] = db.query(
            'SELECT id, username, password_hash, role, two_factor_enabled, two_factor_secret FROM admins WHERE username = ?',
            [username]
        );
        const admin = rows[0];
        if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
            await addAuditLog('admin_login_failed', { username, ip: getClientIp(req) });
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        if (admin.two_factor_enabled) {
            const tempToken = signTempToken({ username: admin.username, id: admin.id });
            return res.json({ success: true, two_factor_required: true, temp_token: tempToken });
        }

        const token = signAdminToken({ username: admin.username, role: admin.role });
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        db.query(
            `INSERT INTO admin_sessions (id, admin_username, token_hash, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'))`,
            [
                crypto.randomUUID(),
                admin.username,
                tokenHash,
                getClientIp(req),
                (req.headers['user-agent'] || '').slice(0, 512),
            ]
        );

        await addAuditLog('admin_login', { username, ip: getClientIp(req) }, username);
        res.json({ success: true, token, username: admin.username, role: admin.role });
    })
);

router.post(
    '/logout',
    requireAuth,
    asyncHandler(async (req, res) => {
        db.query('UPDATE admin_sessions SET revoked = 1 WHERE token_hash = ?', [
            req.adminTokenHash,
        ]);
        await addAuditLog(
            'admin_logout',
            { username: req.admin.username, ip: getClientIp(req) },
            req.admin.username
        );
        res.json({ success: true, message: 'Erfolgreich ausgeloggt.' });
    })
);

router.post(
    '/login/2fa',
    loginLimiter,
    asyncHandler(async (req, res) => {
        const { code, temp_token } = req.body;
        if (!code || !temp_token)
            return res
                .status(400)
                .json({ success: false, message: 'Code and temp_token required' });

        try {
            const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-production';
            const payload = (await import('jsonwebtoken')).default.verify(temp_token, ADMIN_SECRET);
            if (!payload.temp) throw new Error('Invalid token');

            const [rows] = db.query(
                'SELECT username, role, two_factor_secret FROM admins WHERE id = ?',
                [payload.id]
            );
            const admin = rows[0];
            if (!admin) return res.status(401).json({ success: false, message: 'Admin not found' });

            const isValid = authenticator.verify({ token: code, secret: admin.two_factor_secret });
            if (!isValid)
                return res.status(401).json({ success: false, message: 'Invalid 2FA code' });

            const token = signAdminToken({ username: admin.username, role: admin.role });
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            db.query(
                `INSERT INTO admin_sessions (id, admin_username, token_hash, ip, user_agent, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'))`,
                [
                    crypto.randomUUID(),
                    admin.username,
                    tokenHash,
                    getClientIp(req),
                    (req.headers['user-agent'] || '').slice(0, 512),
                ]
            );

            res.json({ success: true, token, username: admin.username, role: admin.role });
        } catch (e) {
            res.status(401).json({ success: false, message: 'Invalid or expired temporary token' });
        }
    })
);

// ── 2FA Setup ────────────────────────────────────────────────────────────────
router.post(
    '/2fa/setup',
    requireAuth,
    asyncHandler(async (req, res) => {
        const [rows] = db.query(
            'SELECT two_factor_enabled, two_factor_secret FROM admins WHERE username = ?',
            [req.admin.username]
        );
        const admin = rows[0];

        let secret = admin.two_factor_secret;
        if (!secret) {
            secret = authenticator.generateSecret();
            db.query('UPDATE admins SET two_factor_secret = ? WHERE username = ?', [
                secret,
                req.admin.username,
            ]);
        }

        const otpauth = authenticator.keyuri(req.admin.username, 'Tafeline License', secret);
        const qrCodeUrl = await QRCode.toDataURL(otpauth);

        res.json({
            success: true,
            secret,
            qr_code: qrCodeUrl,
            enabled: !!admin.two_factor_enabled,
        });
    })
);

router.post(
    '/2fa/verify',
    requireAuth,
    asyncHandler(async (req, res) => {
        const { code } = req.body;
        const [rows] = db.query('SELECT two_factor_secret FROM admins WHERE username = ?', [
            req.admin.username,
        ]);
        const secret = rows[0]?.two_factor_secret;

        if (!secret) return res.status(400).json({ success: false, message: '2FA not set up' });

        const isValid = authenticator.verify({ token: code, secret });
        if (!isValid) return res.status(400).json({ success: false, message: 'Ungültiger Code' });

        db.query('UPDATE admins SET two_factor_enabled = 1 WHERE username = ?', [
            req.admin.username,
        ]);
        await addAuditLog('2fa_enabled', { username: req.admin.username }, req.admin.username);

        res.json({ success: true, message: '2FA erfolgreich aktiviert' });
    })
);

router.post(
    '/2fa/disable',
    requireAuth,
    asyncHandler(async (req, res) => {
        const { password, code } = req.body;

        const [rows] = db.query(
            'SELECT password_hash, two_factor_secret FROM admins WHERE username = ?',
            [req.admin.username]
        );
        const admin = rows[0];
        if (!admin)
            return res.status(404).json({ success: false, message: 'Admin nicht gefunden.' });

        let verified = false;
        if (password) verified = await bcrypt.compare(password, admin.password_hash);
        if (!verified && code && admin.two_factor_secret) {
            verified = authenticator.verify({ token: code, secret: admin.two_factor_secret });
        }

        if (!verified) {
            return res.status(403).json({
                success: false,
                message: 'Bestätigung erforderlich: Passwort oder TOTP-Code ungültig.',
            });
        }

        db.query(
            'UPDATE admins SET two_factor_enabled = 0, two_factor_secret = NULL WHERE username = ?',
            [req.admin.username]
        );
        await addAuditLog('2fa_disabled', { username: req.admin.username }, req.admin.username);
        res.json({ success: true, message: '2FA erfolgreich deaktiviert.' });
    })
);

export default router;
