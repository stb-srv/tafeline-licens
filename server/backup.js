import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { database, query } from './db.js';
import logger from './logger.js';

const STORAGE_PATH = process.env.STORAGE_PATH || './storage';
export const BACKUP_DIR = path.join(STORAGE_PATH, 'backups');

function getRetentionDays() {
    try {
        const [[s]] = query('SELECT backup_retention_days FROM invoice_settings WHERE id = 1');
        return Math.max(1, parseInt(s?.backup_retention_days) || 14);
    } catch {
        return 14;
    }
}

export async function runBackup() {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, `licens-${ts}.db`);
    await database.backup(dest);
    try {
        verifyBackup(dest);
    } catch (err) {
        fs.rmSync(dest, { force: true });
        throw err;
    }
    logger.info({ dest }, 'Datenbank-Backup erstellt und geprüft.');
    copyOffsite(dest);
    return dest;
}

/** Öffnet das Backup schreibgeschützt und prüft Integrität sowie Kerntabellen. */
export function verifyBackup(file) {
    const db = new Database(file, { readonly: true });
    try {
        const [{ integrity_check: result }] = db.pragma('integrity_check');
        if (result !== 'ok') throw new Error(`Backup defekt (integrity_check: ${result})`);
        const hasCore = db
            .prepare(
                "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('licenses','admins','schema_migrations')"
            )
            .get().n;
        if (hasCore < 3) throw new Error('Backup unvollständig (Kerntabellen fehlen)');
        return true;
    } finally {
        db.close();
    }
}

/** Optionale zweite Kopie (BACKUP_COPY_DIR, z. B. gemountetes NAS/Remote-Share). Fehler werden nur geloggt. */
function copyOffsite(file) {
    const dir = process.env.BACKUP_COPY_DIR;
    if (!dir) return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(file, path.join(dir, path.basename(file)));
        logger.info({ dir }, 'Backup-Kopie abgelegt.');
    } catch (err) {
        logger.error({ err, dir }, 'Backup-Kopie fehlgeschlagen.');
    }
}

export function rotateBackups(retentionDays) {
    const days = retentionDays ?? getRetentionDays();
    if (!fs.existsSync(BACKUP_DIR)) return 0;
    const cutoff = Date.now() - days * 86400000;
    const files = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('licens-') && f.endsWith('.db'));
    let removed = 0;
    for (const file of files) {
        const full = path.join(BACKUP_DIR, file);
        if (fs.statSync(full).mtimeMs < cutoff) {
            fs.unlinkSync(full);
            logger.info({ file }, 'Altes Backup geloescht (Rotation).');
            removed++;
        }
    }
    return removed;
}

export function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('licens-') && f.endsWith('.db'))
        .map((f) => {
            const full = path.join(BACKUP_DIR, f);
            return { name: f, path: full, mtime: fs.statSync(full).mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
}
