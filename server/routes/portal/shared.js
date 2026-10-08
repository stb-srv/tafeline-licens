import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../../db.js';
import rateLimit from 'express-rate-limit';

export const PORTAL_SECRET = process.env.PORTAL_SECRET || '';

export const portalLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Zu viele Login-Versuche. Bitte 15 Minuten warten.' },
});
export const inviteLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { success: false, message: 'Zu viele Anfragen. Bitte 1 Stunde warten.' },
});
export const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: {
        success: false,
        message: 'Zu viele Registrierungs-Versuche. Bitte 1 Stunde warten.',
    },
});
export const verifyLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: {
        success: false,
        message: 'Zu viele Verifizierungs-Versuche. Bitte 1 Stunde warten.',
    },
});

export function toDbDate(d) {
    return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}

export function normalizeSlug(str) {
    return str
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/ß/gi, 'ss')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

export function buildPortalUsername(name, company = null) {
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

export function uniquePortalUsername(name, company = null) {
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
export async function requirePortalAuth(req, res, next) {
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
