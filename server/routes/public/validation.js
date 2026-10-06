import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../../db.js';
import { PLAN_DEFINITIONS } from '../../plans.js';
import {
    RSA_PUBLIC_KEY,
    createSignedLicenseToken,
    signResponse,
    isHmacActive,
    HMAC_SECRET,
    getPublicKeyByKid,
} from '../../crypto.js';
import { domainMatches, getClientIp, addAuditLog, parseJsonField } from '../../helpers.js';
import { validateLimiter, offlineTokenLimiter, asyncHandler } from '../../middleware.js';
import logger from '../../logger.js';
import { resolveGrace } from './shared.js';

const router = Router();

// ── Heartbeat ─────────────────────────────────────────────────────────────────
router.post(
    '/heartbeat',
    asyncHandler(async (req, res) => {
        const licenseKey = req.headers['x-license-key'] || req.body?.license_key;
        if (!licenseKey)
            return res.status(400).json({ success: false, message: 'x-license-key Header fehlt.' });

        const [rows] = db.query(
            'SELECT license_key, status, type FROM licenses WHERE license_key = ?',
            [licenseKey]
        );
        if (!rows[0])
            return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden.' });
        if (rows[0].status !== 'active')
            return res.status(403).json({ success: false, message: 'Lizenz nicht aktiv.' });

        db.query(
            `INSERT INTO license_heartbeats (license_key, ip, user_agent, ts)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(license_key) DO UPDATE SET ip=excluded.ip, user_agent=excluded.user_agent, ts=excluded.ts`,
            [rows[0].license_key, req.ip, req.headers['user-agent']?.slice(0, 200) || null]
        );

        return res.json({ success: true, status: rows[0].status, type: rows[0].type });
    })
);

// ── Validate ───────────────────────────────────────────────────────────────────
router.post(
    '/validate',
    validateLimiter,
    asyncHandler(async (req, res) => {
        const { license_key, domain, device_id, device_type, nonce, features_used } = req.body;
        if (!license_key)
            return res.status(400).json({ status: 'invalid', message: 'No key provided' });
        const clientIp = getClientIp(req);

        try {
            const [rows] = db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
            const l = rows[0];

            if (!l) {
                await addAuditLog('validate_failed', {
                    license_key,
                    reason: 'not_found',
                    ip: clientIp,
                });
                return res
                    .status(404)
                    .json({ status: 'invalid', message: 'Lizenz-Key nicht gefunden.' });
            }
            if (l.status !== 'active') {
                await addAuditLog('validate_failed', {
                    license_key,
                    reason: `status_${l.status}`,
                    ip: clientIp,
                });
                return res
                    .status(403)
                    .json({ status: l.status, message: 'Lizenz ist nicht aktiv.' });
            }
            const { licenseStatus, graceUntil, hardExpired } = resolveGrace(l);
            if (hardExpired) {
                await addAuditLog('validate_failed', {
                    license_key,
                    reason: 'expired',
                    ip: clientIp,
                });
                return res
                    .status(403)
                    .json({ status: 'expired', message: 'Lizenz ist abgelaufen.' });
            }
            if (!domainMatches(l.associated_domain, domain)) {
                await addAuditLog('validate_failed', {
                    license_key,
                    reason: 'domain_mismatch',
                    domain,
                    ip: clientIp,
                });
                return res.status(403).json({
                    status: 'domain_mismatch',
                    message: `Lizenz ist nicht für Domain "${domain}" gültig.`,
                });
            }

            if (nonce) {
                const [nonceRows] = db.query('SELECT val FROM used_nonces WHERE val = ?', [nonce]);
                if (nonceRows.length > 0) {
                    await addAuditLog('replay_attack', { license_key, nonce, ip: clientIp });
                    return res
                        .status(400)
                        .json({ status: 'replay', message: 'Nonce already used.' });
                }
                db.query('INSERT INTO used_nonces (val, ts) VALUES (?, ?)', [nonce, Date.now()]);
            }

            if (device_id) {
                const maxDevices = l.max_devices || 0;
                const [licDevices] = db.query(
                    'SELECT * FROM devices WHERE license_key = ? AND active = 1',
                    [license_key]
                );
                const existing = licDevices.find((d) => d.device_id === device_id);
                if (!existing) {
                    if (maxDevices > 0 && licDevices.length >= maxDevices) {
                        await addAuditLog('validate_failed', {
                            license_key,
                            reason: 'device_limit',
                            device_id,
                            ip: clientIp,
                        });
                        return res.status(403).json({
                            status: 'device_limit',
                            message: `Maximale Geräteanzahl (${maxDevices}) erreicht.`,
                        });
                    }
                    db.query(
                        'INSERT INTO devices (id, license_key, device_id, device_type, ip) VALUES (?, ?, ?, ?, ?)',
                        [
                            crypto.randomUUID(),
                            license_key,
                            device_id,
                            device_type || 'unknown',
                            clientIp,
                        ]
                    );
                    await addAuditLog('device_registered', {
                        license_key,
                        device_id,
                        device_type,
                        ip: clientIp,
                    });
                } else {
                    db.query(
                        `UPDATE devices SET last_seen=datetime('now'), ip=?, device_type=? WHERE id=?`,
                        [clientIp, device_type || existing.device_type, existing.id]
                    );
                }
            }

            const today = new Date().toISOString().slice(0, 10);
            const dailyAnalytics = parseJsonField(l.analytics_daily, {});
            const featuresAnalytics = parseJsonField(l.analytics_features, {});
            dailyAnalytics[today] = (dailyAnalytics[today] || 0) + 1;
            const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
            for (const d of Object.keys(dailyAnalytics)) {
                if (d < cutoff) delete dailyAnalytics[d];
            }
            if (features_used && Array.isArray(features_used)) {
                for (const f of features_used)
                    featuresAnalytics[f] = (featuresAnalytics[f] || 0) + 1;
            }

            const validatedDomains = parseJsonField(l.validated_domains, []);
            if (domain && !validatedDomains.includes(domain)) validatedDomains.push(domain);

            db.query(
                `UPDATE licenses SET last_validated=datetime('now'), usage_count=usage_count+1,
              validated_domain=?, validated_domains=?, analytics_daily=?, analytics_features=?
             WHERE license_key=?`,
                [
                    domain || null,
                    JSON.stringify(validatedDomains),
                    JSON.stringify(dailyAnalytics),
                    JSON.stringify(featuresAnalytics),
                    license_key,
                ]
            );

            await addAuditLog('validate_success', {
                license_key,
                domain,
                device_id: device_id || null,
                ip: clientIp,
            });

            const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
            const [custRows] = l.customer_id
                ? db.query('SELECT email, company FROM customers WHERE id = ?', [l.customer_id])
                : [[]];
            const customer = custRows[0] || null;

            // Enterprise bekommt immer alle Plan-Module – DB-Overrides werden ignoriert
            const allowedModules =
                l.type === 'ENTERPRISE'
                    ? { ...plan.modules }
                    : l.allowed_modules
                      ? parseJsonField(l.allowed_modules, plan.modules)
                      : plan.modules;
            const limits = l.limits
                ? parseJsonField(l.limits, {
                      max_dishes: plan.menu_items,
                      max_tables: plan.max_tables,
                  })
                : { max_dishes: plan.menu_items, max_tables: plan.max_tables };

            const entitlements = l.entitlements
                ? { ...allowedModules, ...parseJsonField(l.entitlements, {}) }
                : allowedModules;

            const responsePayload = {
                status: licenseStatus,
                customer_name: l.customer_name,
                type: l.type,
                plan_label: plan.label,
                expires_at: l.expires_at,
                allowed_modules: allowedModules,
                entitlements,
                limits,
                ...(graceUntil ? { grace_until: graceUntil.toISOString() } : {}),
                ...(customer ? { account_email: customer.email, company: customer.company } : {}),
            };

            const signedToken = createSignedLicenseToken(
                {
                    license_key,
                    type: l.type,
                    plan_label: plan.label,
                    expires_at: l.expires_at,
                    allowed_modules: allowedModules,
                    entitlements,
                    limits,
                    domain: domain || l.associated_domain,
                    status: licenseStatus,
                    ...(graceUntil ? { grace_until: graceUntil.toISOString() } : {}),
                    issued_at: Math.floor(Date.now() / 1000),
                },
                '80h'
            );

            const finalResponse = { ...responsePayload };
            if (signedToken) {
                finalResponse.license_token = signedToken;
                finalResponse.token = signedToken;
            }

            return res.json(isHmacActive() ? signResponse(finalResponse) : finalResponse);
        } catch (e) {
            logger.error({ err: e }, 'Validate error');
            res.status(500).json({ status: 'error', message: 'Internal server error' });
        }
    })
);

// ── Refresh ──────────────────────────────────────────────────────────────────────
router.post(
    '/refresh',
    validateLimiter,
    asyncHandler(async (req, res) => {
        const { license_key, domain } = req.body;
        if (!license_key)
            return res.status(400).json({ status: 'invalid', message: 'No key provided' });
        const clientIp = getClientIp(req);

        try {
            const [rows] = db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
            const l = rows[0];

            if (!l) {
                await addAuditLog('refresh_failed', {
                    license_key,
                    reason: 'not_found',
                    ip: clientIp,
                });
                return res
                    .status(404)
                    .json({ status: 'invalid', message: 'Lizenz-Key nicht gefunden.' });
            }
            if (l.status === 'revoked' || l.status === 'cancelled') {
                await addAuditLog('refresh_failed', {
                    license_key,
                    reason: l.status,
                    ip: clientIp,
                });
                return res
                    .status(403)
                    .json({ status: l.status, message: `Lizenz wurde widerrufen (${l.status}).` });
            }
            if (l.status !== 'active') {
                await addAuditLog('refresh_failed', {
                    license_key,
                    reason: `status_${l.status}`,
                    ip: clientIp,
                });
                return res
                    .status(403)
                    .json({ status: l.status, message: 'Lizenz ist nicht aktiv.' });
            }
            const {
                licenseStatus: refreshStatus,
                graceUntil: refreshGrace,
                hardExpired: refreshHardExpired,
            } = resolveGrace(l);
            if (refreshHardExpired) {
                await addAuditLog('refresh_failed', {
                    license_key,
                    reason: 'expired',
                    ip: clientIp,
                });
                return res
                    .status(403)
                    .json({ status: 'expired', message: 'Lizenz ist abgelaufen.' });
            }
            if (domain && !domainMatches(l.associated_domain, domain)) {
                await addAuditLog('refresh_failed', {
                    license_key,
                    reason: 'domain_mismatch',
                    domain,
                    ip: clientIp,
                });
                return res
                    .status(403)
                    .json({ status: 'domain_mismatch', message: 'Domain stimmt nicht überein.' });
            }

            db.query(`UPDATE licenses SET last_heartbeat=datetime('now') WHERE license_key=?`, [
                license_key,
            ]);
            await addAuditLog('refresh_ok', { license_key, domain, ip: clientIp });

            const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
            // Enterprise bekommt immer alle Plan-Module – DB-Overrides werden ignoriert
            const allowedModules =
                l.type === 'ENTERPRISE'
                    ? { ...plan.modules }
                    : l.allowed_modules
                      ? parseJsonField(l.allowed_modules, plan.modules)
                      : plan.modules;
            const limits = l.limits
                ? parseJsonField(l.limits, {
                      max_dishes: plan.menu_items,
                      max_tables: plan.max_tables,
                  })
                : { max_dishes: plan.menu_items, max_tables: plan.max_tables };

            const signedToken = createSignedLicenseToken(
                {
                    license_key,
                    type: l.type,
                    plan_label: plan.label,
                    expires_at: l.expires_at,
                    allowed_modules: allowedModules,
                    limits,
                    domain: domain || l.associated_domain,
                    customer_name: l.customer_name || null,
                    status: refreshStatus,
                    ...(refreshGrace ? { grace_until: refreshGrace.toISOString() } : {}),
                    issued_at: Math.floor(Date.now() / 1000),
                },
                '80h'
            );

            res.json({
                status: refreshStatus,
                token: signedToken,
                type: l.type,
                plan_label: plan.label,
                expires_at: l.expires_at,
                allowed_modules: allowedModules,
                limits,
                ...(refreshGrace ? { grace_until: refreshGrace.toISOString() } : {}),
            });
        } catch (e) {
            logger.error({ err: e }, 'Refresh error');
            res.status(500).json({ status: 'error', message: 'Internal server error' });
        }
    })
);

// ── Verify License Token ──────────────────────────────────────────────────────────
router.post(
    '/verify-license-token',
    validateLimiter,
    asyncHandler(async (req, res) => {
        const { license_token } = req.body;
        if (!license_token)
            return res.status(400).json({ valid: false, message: 'No token provided' });
        try {
            const unverified = jwt.decode(license_token, { complete: true });
            const kid = unverified?.header?.kid ?? null;
            const pubKey = getPublicKeyByKid(kid) || RSA_PUBLIC_KEY;
            if (!pubKey)
                return res
                    .status(400)
                    .json({ valid: false, message: 'Kein Public Key verfügbar.' });
            const decoded = jwt.verify(license_token, pubKey, { algorithms: ['RS256'] });
            res.json({ valid: true, payload: decoded });
        } catch (e) {
            res.status(401).json({
                valid: false,
                message: 'Ungültiges oder abgelaufenes Token: ' + e.message,
            });
        }
    })
);

// ── Offline Token ──────────────────────────────────────────────────────────────────
router.post(
    '/offline-token',
    offlineTokenLimiter,
    asyncHandler(async (req, res) => {
        const { license_key, domain, device_id, duration_hours } = req.body;
        if (!license_key)
            return res.status(400).json({ success: false, message: 'No key provided' });
        try {
            const [rows] = db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
            const l = rows[0];
            if (!l || l.status !== 'active')
                return res.status(403).json({ success: false, message: 'License invalid.' });
            const { licenseStatus: offlineStatus, hardExpired: offlineHardExpired } =
                resolveGrace(l);
            if (offlineHardExpired)
                return res.status(403).json({ success: false, message: 'License expired.' });
            if (domain && !domainMatches(l.associated_domain, domain))
                return res.status(403).json({
                    success: false,
                    message: `Offline-Token: Lizenz ist nicht für Domain "${domain}" gültig.`,
                });

            const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
            const hours = Math.min(duration_hours || 24, 168);
            // Enterprise bekommt immer alle Plan-Module – DB-Overrides werden ignoriert
            const allowedModules =
                l.type === 'ENTERPRISE'
                    ? { ...plan.modules }
                    : l.allowed_modules
                      ? parseJsonField(l.allowed_modules, plan.modules)
                      : plan.modules;
            const limits = l.limits
                ? parseJsonField(l.limits, {
                      max_dishes: plan.menu_items,
                      max_tables: plan.max_tables,
                  })
                : { max_dishes: plan.menu_items, max_tables: plan.max_tables };

            const token = jwt.sign(
                {
                    license_key,
                    domain,
                    device_id,
                    type: l.type,
                    plan_label: plan.label,
                    allowed_modules: allowedModules,
                    limits,
                    offline: true,
                },
                HMAC_SECRET,
                { expiresIn: `${hours}h` }
            );

            await addAuditLog('offline_token_issued', {
                license_key,
                domain,
                device_id: device_id || null,
                duration_hours: hours,
                ip: getClientIp(req),
            });
            res.json({ success: true, offline_token: token, valid_hours: hours });
        } catch (e) {
            logger.error({ err: e }, 'Offline token error');
            res.status(500).json({ success: false, message: 'Internal server error' });
        }
    })
);

router.post(
    '/verify-offline-token',
    asyncHandler(async (req, res) => {
        const { offline_token } = req.body;
        if (!offline_token) return res.status(400).json({ success: false });
        try {
            const decoded = jwt.verify(offline_token, HMAC_SECRET);
            res.json({ success: true, ...decoded });
        } catch (e) {
            res.status(401).json({ success: false, message: 'Invalid or expired offline token' });
        }
    })
);

export default router;
