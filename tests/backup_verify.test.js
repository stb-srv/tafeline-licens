import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tafeline-bk-'));
const { verifyBackup } = await import('../server/backup.js');

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('verifyBackup', () => {
    test('akzeptiert intaktes Backup mit Kerntabellen', () => {
        const f = path.join(dir, 'ok.db');
        const db = new Database(f);
        db.exec(
            'CREATE TABLE licenses(id); CREATE TABLE admins(id); CREATE TABLE schema_migrations(id);'
        );
        db.close();
        expect(verifyBackup(f)).toBe(true);
    });

    test('lehnt Backup ohne Kerntabellen ab', () => {
        const f = path.join(dir, 'empty.db');
        const db = new Database(f);
        db.exec('CREATE TABLE x(id);');
        db.close();
        expect(() => verifyBackup(f)).toThrow(/unvollständig/);
    });

    test('lehnt beschädigte Datei ab', () => {
        const f = path.join(dir, 'broken.db');
        fs.writeFileSync(f, 'das ist keine sqlite datei, nur muell '.repeat(50));
        expect(() => verifyBackup(f)).toThrow();
    });
});
