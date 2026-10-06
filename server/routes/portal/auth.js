import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../../db.js';
import { sendTemplateMail } from '../../mailer/index.js';
import { addAuditLog, asyncHandler } from '../../helpers.js';
import {
    PORTAL_SECRET,
    portalLoginLimiter,
    inviteLimiter,
    registerLimiter,
    verifyLimiter,
    toDbDate,
    uniquePortalUsername,
    requirePortalAuth,
} from './shared.js';

const router = Router();

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
