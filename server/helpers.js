import crypto from 'crypto';
import db from './db.js';

export const generateKey = (type) => {
    const prefix =
        {
            FREE: 'TAFELINE-FREE',
            STARTER: 'TAFELINE-START',
            PRO: 'TAFELINE-PRO',
            PRO_PLUS: 'TAFELINE-PROPLUS',
            ENTERPRISE: 'TAFELINE-ENT',
        }[type] || 'TAFELINE-UNKNOWN';
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${rand}-${new Date().getFullYear()}`;
};

export const normalizeDomain = (raw) => {
    if (!raw) return null;
    return raw
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/:\d+$/, '')
        .split('/')[0]
        .replace(/^www\./, '');
};

export const domainMatches = (pattern, domain) => {
    if (!pattern || pattern === '*') return true;
    if (!domain) return true;
    const cleanDomain = normalizeDomain(domain);
    const cleanPattern = normalizeDomain(pattern);
    if (cleanPattern === cleanDomain) return true;
    if (pattern.startsWith('*.')) {
        const suffix = normalizeDomain(pattern.slice(2));
        return cleanDomain === suffix || cleanDomain.endsWith('.' + suffix);
    }
    return false;
};

export const getClientIp = (req) =>
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown';

// Schema is fixed in SQLite — always 'details' and 'ts'
export const addAuditLog = async (action, details, actor = 'system') => {
    try {
        db.query(
            `INSERT INTO audit_log (id, actor, action, details, ts) VALUES (?, ?, ?, ?, datetime('now'))`,
            [crypto.randomUUID(), actor, action, JSON.stringify(details)]
        );
    } catch (e) {
        console.error('Audit-Log Fehler:', e.message);
    }
};

export const parseJsonField = (value, fallback = {}) => {
    if (!value) return fallback;
    try {
        return typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        return fallback;
    }
};

export const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
