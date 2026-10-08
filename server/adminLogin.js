import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from './db.js';
import { getClientIp, addAuditLog } from './helpers.js';
import { signAdminToken, signTempToken } from './middleware.js';

export function createAdminSession(admin, req) {
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
    return token;
}

/**
 * Shared admin credential check used by the unified login (/api/portal/login)
 * and the legacy /api/admin/login alias.
 * Returns null on unknown user / wrong password (caller decides on audit + response),
 * otherwise { two_factor_required, temp_token } or { token, username, role }.
 */
export async function tryAdminLogin(username, password, req) {
    const [rows] = db.query(
        'SELECT id, username, password_hash, role, two_factor_enabled FROM admins WHERE username = ?',
        [username]
    );
    const admin = rows[0];
    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) return null;

    if (admin.two_factor_enabled) {
        return {
            two_factor_required: true,
            temp_token: signTempToken({ username: admin.username, id: admin.id }),
        };
    }
    const token = createAdminSession(admin, req);
    await addAuditLog('admin_login', { username, ip: getClientIp(req) }, username);
    return { token, username: admin.username, role: admin.role };
}
