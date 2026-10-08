import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { getClientIp, addAuditLog } from '../helpers.js';
import { requireAuth, loginLimiter, asyncHandler } from '../middleware.js';
import { tryAdminLogin, createAdminSession } from '../adminLogin.js';
import { newTotpSecret, totpUri, verifyTotp } from '../totp.js';
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
// Legacy alias: the UI uses the unified login (POST /api/portal/login).
router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password)
            return res
                .status(400)
                .json({ success: false, message: 'Username and password required' });

        const result = await tryAdminLogin(username, password, req);
        if (!result) {
            await addAuditLog('admin_login_failed', { username, ip: getClientIp(req) });
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        res.json({ success: true, ...result });
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

            const isValid = verifyTotp(code, admin.two_factor_secret);
            if (!isValid)
                return res.status(401).json({ success: false, message: 'Invalid 2FA code' });

            const token = createAdminSession(admin, req);
            await addAuditLog(
                'admin_login',
                { username: admin.username, ip: getClientIp(req) },
                admin.username
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
            secret = newTotpSecret();
            db.query('UPDATE admins SET two_factor_secret = ? WHERE username = ?', [
                secret,
                req.admin.username,
            ]);
        }

        const otpauth = totpUri(req.admin.username, 'Tafeline License', secret);
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

        const isValid = verifyTotp(code, secret);
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
            verified = verifyTotp(code, admin.two_factor_secret);
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
