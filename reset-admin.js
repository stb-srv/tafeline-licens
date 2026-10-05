#!/usr/bin/env node
// Setzt das Passwort eines Admin-Accounts direkt in der SQLite-Datenbank.
// Aufruf: node reset-admin.js [username] [neues-passwort]
// Ohne Argumente: interaktive Abfrage

import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import readline from 'readline';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'licens.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`\n❌  Datenbank nicht gefunden: ${DB_PATH}`);
    console.error('   Stelle sicher dass der Service mindestens einmal gestartet wurde.');
    process.exit(1);
}

const db = new Database(DB_PATH);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

async function main() {
    const admins = db.prepare('SELECT username, role FROM admins ORDER BY role DESC').all();

    console.log('\n  Tafeline – Admin Passwort Reset\n');

    if (admins.length === 0) {
        console.log('  Keine Admin-Accounts gefunden. Erstelle neuen Superadmin.\n');

        const username = process.argv[2] || (await ask('  Benutzername: '));
        const password =
            process.argv[3] || (await askPassword('  Neues Passwort (min. 12 Zeichen): '));

        if (password.length < 12) {
            console.error('\n❌  Passwort zu kurz (min. 12 Zeichen).');
            process.exit(1);
        }

        const hash = await bcrypt.hash(password, 12);
        db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)').run(
            username,
            hash,
            'superadmin'
        );
        console.log(`\n✅  Superadmin '${username}' erstellt.\n`);
    } else {
        console.log('  Vorhandene Accounts:');
        admins.forEach((a, i) => console.log(`    [${i + 1}] ${a.username} (${a.role})`));
        console.log('');

        let targetUsername;
        if (process.argv[2]) {
            targetUsername = process.argv[2];
        } else {
            const input = await ask('  Benutzername (Enter = erster in der Liste): ');
            targetUsername = input.trim() || admins[0].username;
        }

        const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(targetUsername);
        if (!admin) {
            console.error(`\n❌  Benutzer '${targetUsername}' nicht gefunden.`);
            process.exit(1);
        }

        const password =
            process.argv[3] ||
            (await askPassword(`  Neues Passwort für '${targetUsername}' (min. 12 Zeichen): `));

        if (password.length < 12) {
            console.error('\n❌  Passwort zu kurz (min. 12 Zeichen).');
            process.exit(1);
        }

        const hash = await bcrypt.hash(password, 12);
        db.prepare('UPDATE admins SET password_hash = ? WHERE username = ?').run(
            hash,
            targetUsername
        );

        // Alle Sessions dieses Users invalidieren
        db.prepare('DELETE FROM admin_sessions WHERE admin_username = ?').run(targetUsername);
        console.log(`\n✅  Passwort für '${targetUsername}' zurückgesetzt.`);
        console.log('   Alle aktiven Sessions wurden beendet.\n');
    }

    rl.close();
    db.close();
}

async function askPassword(prompt) {
    // Passwort-Eingabe ohne Echo (Linux/Mac)
    process.stdout.write(prompt);
    return new Promise((resolve) => {
        const stdin = process.stdin;
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let pw = '';
        stdin.on('data', function handler(ch) {
            if (ch === '\n' || ch === '\r' || ch === '') {
                stdin.setRawMode?.(false);
                stdin.pause();
                stdin.removeListener('data', handler);
                process.stdout.write('\n');
                if (ch === '') process.exit(0);
                resolve(pw);
            } else if (ch === '') {
                pw = pw.slice(0, -1);
            } else {
                pw += ch;
            }
        });
    });
}

main().catch((e) => {
    console.error('Fehler:', e.message);
    process.exit(1);
});
