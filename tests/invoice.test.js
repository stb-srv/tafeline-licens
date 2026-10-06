import request from 'supertest';
import { app } from '../server.js';
import db from '../server/db.js';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

const ADMIN_SECRET = 'secure-test-secret';

describe('Invoice Admin API', () => {
    let adminToken;

    beforeAll(() => {
        adminToken = jwt.sign({ username: 'testadmin', role: 'admin' }, ADMIN_SECRET);
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ── Auth guards ────────────────────────────────────────────────────────────

    test('GET /api/admin/invoices requires auth', async () => {
        const res = await request(app).get('/api/admin/invoices');
        expect(res.statusCode).toBe(401);
    });

    test('DELETE /api/admin/invoices/:id requires superadmin', async () => {
        jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('FROM admin_sessions')) return [[{ id: 'sess1' }]];
            if (sql.includes('FROM admins WHERE username'))
                return [[{ id: 1, username: 'testadmin', role: 'admin' }]];
            return [[]];
        });

        const res = await request(app)
            .delete('/api/admin/invoices/INV-001')
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.statusCode).toBe(403);
    });

    // ── List invoices ──────────────────────────────────────────────────────────

    test('GET /api/admin/invoices returns list with auth', async () => {
        jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('FROM admin_sessions')) return [[{ id: 'sess1' }]];
            if (sql.includes('FROM admins WHERE username'))
                return [[{ id: 1, username: 'testadmin', role: 'admin' }]];
            if (sql.includes('COUNT(*)')) return [[{ total: 2 }]];
            if (sql.includes('FROM invoices'))
                return [
                    [
                        {
                            id: 'inv1',
                            invoice_number: 'INV-2024-0001',
                            status: 'draft',
                            amount_gross: 29.0,
                        },
                        {
                            id: 'inv2',
                            invoice_number: 'INV-2024-0002',
                            status: 'sent',
                            amount_gross: 59.0,
                        },
                    ],
                ];
            return [[]];
        });

        const res = await request(app)
            .get('/api/admin/invoices')
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    // ── Invoice status ─────────────────────────────────────────────────────────

    test('POST /api/admin/invoices/:id/send requires auth', async () => {
        const res = await request(app).post('/api/admin/invoices/inv1/send');
        expect(res.statusCode).toBe(401);
    });

    test('GET /api/admin/invoices/:id returns 404 for missing invoice', async () => {
        jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('FROM admin_sessions')) return [[{ id: 'sess1' }]];
            if (sql.includes('FROM admins WHERE username'))
                return [[{ id: 1, username: 'testadmin', role: 'admin' }]];
            if (sql.includes('FROM invoices')) return [[]];
            return [[]];
        });

        const res = await request(app)
            .get('/api/admin/invoices/nonexistent')
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.statusCode).toBe(404);
    });

    // ── Invoice creation ───────────────────────────────────────────────────────

    test('POST /api/admin/invoices validates required fields', async () => {
        jest.spyOn(db, 'query').mockImplementation((sql) => {
            if (sql.includes('FROM admin_sessions')) return [[{ id: 'sess1' }]];
            if (sql.includes('FROM admins WHERE username'))
                return [[{ id: 1, username: 'testadmin', role: 'admin' }]];
            return [[]];
        });

        const res = await request(app)
            .post('/api/admin/invoices')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({});

        expect(res.statusCode).toBe(400);
    });
});

describe('calculateInvoiceTotals', () => {
    let calculateInvoiceTotals;

    beforeAll(async () => {
        const mod = await import('../server/invoiceHelper.js');
        calculateInvoiceTotals = mod.calculateInvoiceTotals;
    });

    test('calculates net, tax, and gross correctly', () => {
        const result = calculateInvoiceTotals(
            [
                { quantity: 2, unit_price: 50 },
                { quantity: 1, unit_price: 29 },
            ],
            19
        );
        expect(result.amount_net).toBe(129.0);
        expect(result.amount_tax).toBe(24.51);
        expect(result.amount_gross).toBe(153.51);
    });

    test('handles zero tax rate', () => {
        const result = calculateInvoiceTotals([{ quantity: 1, unit_price: 100 }], 0);
        expect(result.amount_net).toBe(100.0);
        expect(result.amount_tax).toBe(0);
        expect(result.amount_gross).toBe(100.0);
    });

    test('returns zeros for empty items', () => {
        const result = calculateInvoiceTotals([], 19);
        expect(result.amount_net).toBe(0);
        expect(result.amount_gross).toBe(0);
    });

    test('handles float quantities correctly', () => {
        const result = calculateInvoiceTotals([{ quantity: 0.5, unit_price: 100 }], 20);
        expect(result.amount_net).toBe(50.0);
        expect(result.amount_gross).toBe(60.0);
    });
});
