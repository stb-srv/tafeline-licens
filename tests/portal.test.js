import request from 'supertest';
import { app } from '../server.js';
import db from '../server/db.js';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';

const PORTAL_SECRET = 'portal-secure-test-secret';
// Inject secret for test
process.env.PORTAL_SECRET = PORTAL_SECRET;

describe('Customer Portal API', () => {
    let portalToken;

    beforeAll(() => {
        portalToken = jwt.sign({ customer_id: 'cust1', type: 'portal' }, PORTAL_SECRET);
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('GET /api/portal/me should require login', async () => {
        const res = await request(app).get('/api/portal/me');
        expect(res.statusCode).toBe(401);
    });

    test('GET /api/portal/me should return customer data when logged in', async () => {
        const mockDb = jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('customer_sessions')) return [[{ id: 'sess1' }]];
            if (sql.includes('FROM customers WHERE id')) {
                return [
                    [
                        {
                            id: 'cust1',
                            name: 'Max Mustermann',
                            email: 'max@test.de',
                            must_change_password: 0,
                        },
                    ],
                ];
            }
            return [[]];
        });

        const res = await request(app)
            .get('/api/portal/me')
            .set('Authorization', `Bearer ${portalToken}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.customer.name).toBe('Max Mustermann');

        mockDb.mockRestore();
    });

    test('PATCH /api/portal/licenses/:key/domain should validate domain format', async () => {
        jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('customer_sessions')) return [[{ id: 's1' }]];
            if (sql.includes('FROM customers WHERE id')) return [[{ id: 'cust1' }]];
            return [[]];
        });

        const res = await request(app)
            .patch('/api/portal/licenses/KEY123/domain')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({ domain: 'invalid domain' });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('Ungültige Domain');
    });

    test('PATCH /api/portal/update-profile should validate billing fields', async () => {
        jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('customer_sessions')) return [[{ id: 's1' }]];
            if (sql.includes('FROM customers WHERE id')) return [[{ id: 'cust1' }]];
            return [[]];
        });

        // 1. Invalid zip code (letters/numbers only, max 10 chars)
        let res = await request(app)
            .patch('/api/portal/update-profile')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({ billing_zip: '12345-67890' });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('Postleitzahl ist ungültig');

        // 2. Invalid country code (2-letter ISO only)
        res = await request(app)
            .patch('/api/portal/update-profile')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({ billing_country: 'GER' });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('Ungültiges Land');
    });

    test('PATCH /api/portal/update-profile should update billing fields when valid', async () => {
        const mockDb = jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('customer_sessions')) return [[{ id: 's1' }]];
            if (sql.includes('FROM customers WHERE id')) {
                return [
                    [
                        {
                            id: 'cust1',
                            name: 'Max',
                            email: 'max@test.de',
                            billing_street: 'Hauptstr. 1',
                            billing_city: 'Berlin',
                            billing_zip: '10115',
                            billing_country: 'DE',
                            tax_id: 'DE123456789',
                        },
                    ],
                ];
            }
            return [[]];
        });

        const res = await request(app)
            .patch('/api/portal/update-profile')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({
                billing_street: 'Hauptstr. 1',
                billing_city: 'Berlin',
                billing_zip: '10115',
                billing_country: 'de',
                tax_id: 'DE123456789',
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.customer.billing_street).toBe('Hauptstr. 1');
        expect(res.body.customer.billing_zip).toBe('10115');
        expect(res.body.customer.billing_country).toBe('DE'); // converted to uppercase
        expect(res.body.customer.tax_id).toBe('DE123456789');

        mockDb.mockRestore();
    });

    test('POST /api/portal/login should reject unverified customer', async () => {
        const mockDb = jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('FROM customers')) {
                return [
                    [
                        {
                            id: 'cust1',
                            name: 'Max',
                            email: 'max@test.de',
                            password_hash: 'hashed',
                            verified: 0,
                        },
                    ],
                ];
            }
            return [[]];
        });
        const mockCompare = jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);

        const res = await request(app)
            .post('/api/portal/login')
            .send({ email: 'max@test.de', password: 'password123' });

        expect(res.statusCode).toBe(403);
        expect(res.body.email_not_verified).toBe(true);

        mockDb.mockRestore();
        mockCompare.mockRestore();
    });

    test('POST /api/portal/register should validate and register user', async () => {
        const mockDb = jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('FROM customers WHERE email')) {
                return [[]]; // email not taken
            }
            if (sql.includes('portal_username')) {
                return [[{ n: 0 }]];
            }
            if (sql.includes('smtp_config')) {
                return [
                    [
                        {
                            id: 1,
                            host: 'localhost',
                            port: 587,
                            smtp_user: 'test',
                            smtp_pass: 'test',
                            smtp_from: 'test@test.de',
                        },
                    ],
                ];
            }
            return [[]];
        });
        const mockCreateTransport = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({
            sendMail: jest.fn().mockResolvedValue({ messageId: 'mock-id' }),
            verify: jest.fn().mockResolvedValue(true),
        });

        const res = await request(app).post('/api/portal/register').send({
            name: 'Test Customer',
            email: 'newcust@test.de',
            password: 'supersecretpassword10',
            company: 'My Company',
            billing_street: 'Test Road 10',
            billing_city: 'Munich',
            billing_zip: '80331',
            billing_country: 'DE',
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toContain('Registrierung erfolgreich');

        mockDb.mockRestore();
        mockCreateTransport.mockRestore();
    });

    test('POST /api/portal/verify-email should verify token', async () => {
        const mockDb = jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('email_verify_token')) {
                return [[{ id: 'cust1' }]];
            }
            return [[]];
        });

        const res = await request(app)
            .post('/api/portal/verify-email')
            .send({ token: 'sometoken' });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        mockDb.mockRestore();
    });

    test('GET /api/portal/plans should return active plans', async () => {
        const mockDb = jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('plan_pricing')) {
                return [
                    [
                        {
                            id: 'PRO',
                            plan_id: 'PRO',
                            price: 59,
                            active: 1,
                            sort_order: 1,
                            features: '[]',
                        },
                        {
                            id: 'STARTER',
                            plan_id: 'STARTER',
                            price: 29,
                            active: 1,
                            sort_order: 0,
                            features: '[]',
                        },
                    ],
                ];
            }
            return [[]];
        });

        const res = await request(app).get('/api/portal/plans');
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.plans)).toBe(true);
        expect(res.body.plans.length).toBeGreaterThan(0);
        expect(res.body.plans[0]).toHaveProperty('id');
        expect(res.body.plans[0]).toHaveProperty('price');

        mockDb.mockRestore();
    });

    test('POST /api/portal/licenses/book should book license and create invoice', async () => {
        // createInvoiceFromLicense runs inside db.runTransaction; execute the fn inline.
        const mockTx = jest.spyOn(db, 'runTransaction').mockImplementation((fn) => fn());
        const mockDb = jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('customer_sessions')) return [[{ id: 's1' }]];
            if (sql.includes('FROM customers WHERE id')) {
                return [
                    [
                        {
                            id: 'cust1',
                            name: 'Max',
                            email: 'max@test.de',
                            currency: 'EUR',
                            verified: 1,
                        },
                    ],
                ];
            }
            if (sql.includes('FROM licenses WHERE license_key')) {
                return [
                    [{ license_key: 'TAFELINE-PRO-TEST-2026', customer_id: 'cust1', type: 'PRO' }],
                ];
            }
            if (sql.includes('plan_pricing')) return [[{ price: 59, tax_rate: 19 }]];
            if (sql.includes('FROM invoice_settings')) {
                return [[{ invoice_prefix: 'INV', next_number: 1 }]];
            }
            if (sql.includes('AS maxNum')) return [[{ maxNum: 0 }]];
            if (sql.includes('COUNT(*) AS n FROM invoices')) return [[{ n: 0 }]];
            return [[]];
        });

        const res = await request(app)
            .post('/api/portal/licenses/book')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({ plan_id: 'PRO', domain: 'myrestaurant.de' });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.license_key).toBeDefined();
        expect(res.body.invoice_id).toBeDefined();

        mockDb.mockRestore();
        mockTx.mockRestore();
    });

    // ── Upgrade endpoint (B4) ─────────────────────────────────────────────────

    test('POST /api/portal/licenses/:key/upgrade requires auth', async () => {
        const res = await request(app)
            .post('/api/portal/licenses/TEST-KEY/upgrade')
            .send({ new_type: 'PRO' });
        expect(res.statusCode).toBe(401);
    });

    test('POST /api/portal/licenses/:key/upgrade rejects downgrade', async () => {
        jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('customer_sessions')) return [[{ id: 's1' }]];
            if (sql.includes('FROM customers WHERE id'))
                return [[{ id: 'cust1', name: 'Test', email: 'test@example.com' }]];
            if (sql.includes('FROM licenses WHERE license_key')) {
                return [
                    [
                        {
                            license_key: 'K1',
                            type: 'PRO',
                            status: 'active',
                            customer_id: 'cust1',
                            expires_at: '2025-12-31',
                        },
                    ],
                ];
            }
            return [[]];
        });

        const res = await request(app)
            .post('/api/portal/licenses/K1/upgrade')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({ new_type: 'STARTER' });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/downgrade|Downgrade/i);
    });

    test('POST /api/portal/licenses/:key/upgrade rejects invalid plan type', async () => {
        jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('customer_sessions')) return [[{ id: 's1' }]];
            if (sql.includes('FROM customers WHERE id'))
                return [[{ id: 'cust1', name: 'Test', email: 'test@example.com' }]];
            return [[]];
        });

        const res = await request(app)
            .post('/api/portal/licenses/K1/upgrade')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({ new_type: 'INVALID_PLAN' });

        expect(res.statusCode).toBe(400);
    });

    test('POST /api/portal/licenses/:key/upgrade returns 404 when license not found', async () => {
        jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('customer_sessions')) return [[{ id: 's1' }]];
            if (sql.includes('FROM customers WHERE id'))
                return [[{ id: 'cust1', name: 'Test', email: 'test@example.com' }]];
            if (sql.includes('FROM licenses WHERE license_key')) return [[]];
            return [[]];
        });

        const res = await request(app)
            .post('/api/portal/licenses/NOTEXIST/upgrade')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({ new_type: 'PRO' });

        expect(res.statusCode).toBe(404);
    });

    // ── Stats endpoint (C5) ───────────────────────────────────────────────────

    test('GET /api/portal/stats requires auth', async () => {
        const res = await request(app).get('/api/portal/stats');
        expect(res.statusCode).toBe(401);
    });

    test('GET /api/portal/stats returns stats object when authenticated', async () => {
        jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('customer_sessions')) return [[{ id: 's1' }]];
            if (sql.includes('FROM customers WHERE id'))
                return [[{ id: 'cust1', name: 'Test', email: 'test@example.com' }]];
            if (sql.includes('license_devices')) return [[{ cnt: 5 }]];
            return [[]];
        });

        const res = await request(app)
            .get('/api/portal/stats')
            .set('Authorization', `Bearer ${portalToken}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.stats).toBeDefined();
    });
});
