import db from '../../db.js';

export const SETUP_TOKEN = process.env.SETUP_TOKEN || '';

export function toDbDate(d) {
    return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}

export function getGraceDays(license) {
    if (license.grace_period_days != null) return license.grace_period_days;
    try {
        const [[s]] = db.query('SELECT grace_period_days FROM invoice_settings WHERE id = 1');
        return s?.grace_period_days ?? 7;
    } catch {
        return 7;
    }
}

export function resolveGrace(license) {
    const now = new Date();
    const expiresAt = new Date(license.expires_at);
    if (now <= expiresAt) return { licenseStatus: 'active', graceUntil: null, hardExpired: false };
    const graceDays = getGraceDays(license);
    const graceUntil = new Date(expiresAt.getTime() + graceDays * 86400000);
    if (now <= graceUntil) return { licenseStatus: 'grace', graceUntil, hardExpired: false };
    return { licenseStatus: 'expired', graceUntil, hardExpired: true };
}
