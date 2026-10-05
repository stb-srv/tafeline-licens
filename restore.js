#!/usr/bin/env node
/**
 * Tafeline License Server – Restore CLI
 * Usage:  node restore.js              → lists available backups
 *         node restore.js <filename>   → restores that backup
 * IMPORTANT: Stop the server before restoring!
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_PATH = process.env.STORAGE_PATH || './storage';
const BACKUP_DIR = path.join(STORAGE_PATH, 'backups');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'licens.db');

function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('licens-') && f.endsWith('.db'))
        .sort()
        .reverse();
}

function restore(backupName) {
    const src = path.join(BACKUP_DIR, backupName);
    if (!fs.existsSync(src)) {
        console.error('Backup nicht gefunden:', src);
        process.exit(1);
    }

    if (fs.existsSync(DB_PATH)) {
        const safetyPath = `${DB_PATH}.before-restore.${Date.now()}`;
        fs.copyFileSync(DB_PATH, safetyPath);
        console.log('✅  Sicherheitskopie erstellt:', safetyPath);
    }
    fs.copyFileSync(src, DB_PATH);
    console.log('✅  Wiederhergestellt von:', src);
    console.log(
        "ℹ️   Integrity-Check: node -e \"import('better-sqlite3').then(({default:D})=>{const db=new D('./data/licens.db');console.log(db.pragma('integrity_check',{simple:true}));db.close();})\""
    );
}

const backups = listBackups();
const target = process.argv[2];

if (target) {
    console.log('⚠️  Stelle sicher dass der Server gestoppt ist!');
    restore(target);
} else if (backups.length === 0) {
    console.log('Keine Backups vorhanden. Pfad:', BACKUP_DIR);
} else {
    console.log('Verfügbare Backups (neueste zuerst):');
    backups.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
    console.log('\nWiederherstellung: node restore.js <backup-dateiname>');
}
