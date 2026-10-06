import { jest } from '@jest/globals';
import fs from 'fs';

jest.unstable_mockModule('better-sqlite3', () => ({
    default: jest.fn(() => ({
        pragma: () => [{ integrity_check: 'ok' }],
        prepare: () => ({ get: () => ({ n: 3 }) }),
        close: jest.fn(),
    })),
}));
jest.unstable_mockModule('../server/db.js', () => ({
    database: { backup: jest.fn().mockResolvedValue(undefined) },
    query: jest.fn().mockReturnValue([[{ backup_retention_days: 14 }]]),
}));
jest.unstable_mockModule('../server/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { runBackup, rotateBackups, listBackups } = await import('../server/backup.js');

afterEach(() => jest.clearAllMocks());

describe('WP2 – Backup', () => {
    test('runBackup calls database.backup() and returns path', async () => {
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        const { database } = await import('../server/db.js');
        const result = await runBackup();
        expect(database.backup).toHaveBeenCalledTimes(1);
        expect(result).toMatch(/licens-.*\.db$/);
        jest.restoreAllMocks();
    });

    test('rotateBackups deletes files older than retention', () => {
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readdirSync').mockReturnValue([
            'licens-2020-01-01T00-00-00.db',
            'licens-2099-01-01T00-00-00.db',
        ]);
        jest.spyOn(fs, 'statSync').mockImplementation((p) => ({
            mtimeMs: p.includes('2020') ? Date.now() - 100 * 86400000 : Date.now(),
        }));
        const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
        const removed = rotateBackups(14);
        expect(removed).toBe(1);
        expect(unlinkSpy).toHaveBeenCalledTimes(1);
        jest.restoreAllMocks();
    });

    test('rotateBackups returns 0 when no old files', () => {
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readdirSync').mockReturnValue(['licens-2099-01-01T00-00-00.db']);
        jest.spyOn(fs, 'statSync').mockReturnValue({ mtimeMs: Date.now() });
        const removed = rotateBackups(14);
        expect(removed).toBe(0);
        jest.restoreAllMocks();
    });

    test('listBackups returns empty array when dir missing', () => {
        jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        expect(listBackups()).toEqual([]);
        jest.restoreAllMocks();
    });
});
