import request from 'supertest';
import { app } from '../server.js';
import db from '../server/db.js';
import { jest } from '@jest/globals';

const mockLicense = (overrides = {}) => ({
    license_key: 'TAFELINE-TEST-GRACE',
    type: 'PRO',
    status: 'active',
    customer_name: 'Test GmbH',
    associated_domain: 'test.example.com',
    expires_at: '2099-01-01 00:00:00',
    grace_period_days: null,
    allowed_modules: null,
    limits: null,
    max_devices: 0,
    customer_id: null,
    analytics_daily: null,
    analytics_features: null,
    validated_domains: null,
    ...overrides,
});

const ACTIVE_LICENSE = mockLicense();
const GRACE_LICENSE = mockLicense({
    expires_at: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 19).replace('T', ' '),
});
const EXPIRED_LICENSE = mockLicense({ expires_at: '2020-01-01 00:00:00' });
const ZERO_GRACE = mockLicense({ expires_at: '2020-01-01 00:00:00', grace_period_days: 0 });

const mockQuery = (license) =>
    jest.spyOn(db, 'query').mockImplementation((sql) => {
        if (sql.includes('SELECT 1')) return [[{ 1: 1 }]];
        if (sql.includes('FROM licenses WHERE license_key')) return [[license]];
        if (sql.includes('FROM invoice_settings')) return [[{ grace_period_days: 7 }]];
        if (sql.includes('used_nonces')) return [[]];
        if (sql.includes('FROM devices')) return [[]];
        if (sql.includes('FROM customers')) return [[]];
        return [{ affectedRows: 1, insertId: 1 }];
    });

afterEach(() => jest.restoreAllMocks());

describe('WP1 – Grace-Period / Soft-Expiry', () => {
    test('active license returns status=active, no grace_until', async () => {
        mockQuery(ACTIVE_LICENSE);
        const res = await request(app)
            .post('/api/v1/validate')
            .send({ license_key: 'TAFELINE-TEST-GRACE', domain: 'test.example.com' });
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('active');
        expect(res.body.grace_until).toBeUndefined();
    });

    test('license 2 days expired with 7-day grace returns status=grace with grace_until', async () => {
        mockQuery(GRACE_LICENSE);
        const res = await request(app)
            .post('/api/v1/validate')
            .send({ license_key: 'TAFELINE-TEST-GRACE', domain: 'test.example.com' });
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('grace');
        expect(res.body.grace_until).toBeDefined();
    });

    test('license past all grace (grace_period_days=0) returns 403 expired', async () => {
        mockQuery(ZERO_GRACE);
        const res = await request(app)
            .post('/api/v1/validate')
            .send({ license_key: 'TAFELINE-TEST-GRACE', domain: 'test.example.com' });
        expect(res.statusCode).toBe(403);
        expect(res.body.status).toBe('expired');
    });

    test('license expired years ago returns 403 expired', async () => {
        mockQuery(EXPIRED_LICENSE);
        const res = await request(app)
            .post('/api/v1/validate')
            .send({ license_key: 'TAFELINE-TEST-GRACE', domain: 'test.example.com' });
        expect(res.statusCode).toBe(403);
        expect(res.body.status).toBe('expired');
    });

    test('refresh with grace-period license returns status=grace', async () => {
        mockQuery(GRACE_LICENSE);
        const res = await request(app)
            .post('/api/v1/refresh')
            .send({ license_key: 'TAFELINE-TEST-GRACE' });
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('grace');
        expect(res.body.grace_until).toBeDefined();
    });

    test('refresh with hard-expired license returns 403', async () => {
        mockQuery(EXPIRED_LICENSE);
        const res = await request(app)
            .post('/api/v1/refresh')
            .send({ license_key: 'TAFELINE-TEST-GRACE' });
        expect(res.statusCode).toBe(403);
        expect(res.body.status).toBe('expired');
    });
});
