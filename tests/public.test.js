import request from 'supertest';
import { app } from '../server.js';
import db from '../server/db.js';
import { jest } from '@jest/globals';

// DB Mock
jest.spyOn(db, 'query').mockImplementation((sql, _params) => {
    if (sql.includes('SELECT 1')) {
        return Promise.resolve([[{ 1: 1 }], []]);
    }
    if (sql.includes('SELECT * FROM licenses')) {
        return Promise.resolve([[], []]);
    }
    return Promise.resolve([[], []]);
});

describe('Public API', () => {
    test('GET /api/v1/health should return ok', async () => {
        const res = await request(app).get('/api/v1/health');
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    test('GET /api/v1/public-key should return a key', async () => {
        const res = await request(app).get('/api/v1/public-key');
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('public_key');
    });

    test('POST /api/v1/validate without key should return 400', async () => {
        const res = await request(app).post('/api/v1/validate').send({});
        expect(res.statusCode).toBe(400);
        expect(res.body.status).toBe('invalid');
    });
});
