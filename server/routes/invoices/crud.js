import express from 'express';
import db from '../../db.js';
import { requireAuth, requireSuperAdmin } from '../../middleware.js';
import { asyncHandler, addAuditLog } from '../../helpers.js';
import {
    generateInvoiceNumber,
    calculateInvoiceTotals,
    getInvoiceWithItems,
} from '../../invoiceHelper.js';
import crypto from 'crypto';
import fs from 'fs';
import { toDbDate } from './shared.js';
import logger from '../../logger.js';

const router = express.Router();

// ── GET /invoices ────────────────────────────────────────────────────────────
router.get(
    '/invoices',
    requireAuth,
    asyncHandler(async (req, res) => {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 25));
        const offset = (page - 1) * limit;

        let where = '1=1';
        const params = [];

        if (req.query.status) {
            where += ' AND i.status = ?';
            params.push(req.query.status);
        }
        if (req.query.customer_id) {
            where += ' AND i.customer_id = ?';
            params.push(req.query.customer_id);
        }
        if (req.query.search) {
            const search = `%${req.query.search.replace(/[%_\\]/g, '\\$&')}%`;
            where += ` AND (i.invoice_number LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.company LIKE ? ESCAPE '\\')`;
            params.push(search, search, search);
        }

        const [[{ total }]] = db.query(
            `SELECT COUNT(*) AS total FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE ${where}`,
            params
        );
        const [rows] = db.query(
            `SELECT i.*, c.name AS customer_name, c.company AS customer_company
         FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id
         WHERE ${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        res.json({
            success: true,
            invoices: rows,
            total: parseInt(total),
            page,
            pages: Math.ceil(total / limit),
        });
    })
);

// ── GET /invoices/:id ────────────────────────────────────────────────────────
router.get(
    '/invoices/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
        const invoice = getInvoiceWithItems(req.params.id);
        if (!invoice)
            return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });
        res.json(invoice);
    })
);

// ── POST /invoices ───────────────────────────────────────────────────────────
router.post(
    '/invoices',
    requireAuth,
    asyncHandler(async (req, res) => {
        const {
            customer_id,
            license_key,
            items: rawItems,
            tax_rate,
            due_date,
            notes,
            type,
            discount_pct,
        } = req.body;
        if (!customer_id)
            return res
                .status(400)
                .json({ success: false, message: 'customer_id ist erforderlich.' });

        const discountPct = Math.min(100, Math.max(0, parseFloat(discount_pct) || 0));
        const discountFactor = 1 - discountPct / 100;

        // Auto-fill from plan_pricing when license_key given but no items provided
        let items = rawItems;
        if ((!items || items.length === 0) && license_key) {
            const [[lic]] = db.query('SELECT type FROM licenses WHERE license_key = ?', [
                license_key,
            ]);
            if (lic) {
                const [[pp]] = db.query(
                    'SELECT price, label FROM plan_pricing WHERE plan_id = ? AND active = 1',
                    [lic.type]
                );
                const basePrice = pp ? parseFloat(pp.price) : 0;
                const label = pp?.label || lic.type;
                items = [
                    {
                        description:
                            discountPct > 0
                                ? `Lizenzgebühr ${label} (${discountPct}% Rabatt)`
                                : `Lizenzgebühr ${label}`,
                        quantity: 1,
                        unit_price: parseFloat((basePrice * discountFactor).toFixed(2)),
                    },
                ];
            }
        }

        if (!items || !Array.isArray(items) || items.length === 0)
            return res.status(400).json({
                success: false,
                message: 'Mindestens eine Position (item) ist erforderlich.',
            });

        // Apply invoice-level discount to all items
        const effectiveItems =
            discountPct > 0
                ? items.map((item) => ({
                      ...item,
                      unit_price: parseFloat(
                          (parseFloat(item.unit_price || 0) * discountFactor).toFixed(2)
                      ),
                  }))
                : items;

        const tax = tax_rate !== undefined ? parseFloat(tax_rate) : 19.0;
        const { amount_net, amount_tax, amount_gross } = calculateInvoiceTotals(
            effectiveItems,
            tax
        );
        const invType = type || 'invoice';

        try {
            let invoiceId;
            db.runTransaction(() => {
                const invoiceNumber = generateInvoiceNumber();
                invoiceId = crypto.randomUUID();

                const [[customer]] = db.query('SELECT currency FROM customers WHERE id = ?', [
                    customer_id,
                ]);
                if (!customer) throw new Error(`Customer with ID ${customer_id} not found.`);

                const currency = customer.currency || 'EUR';

                db.query(
                    `INSERT INTO invoices (
                    id, invoice_number, customer_id, license_key, status, type,
                    amount_net, amount_tax, amount_gross, tax_rate, currency,
                    due_date, notes, created_by, discount_pct
                ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        invoiceId,
                        invoiceNumber,
                        customer_id,
                        license_key || null,
                        invType,
                        amount_net,
                        amount_tax,
                        amount_gross,
                        tax,
                        currency,
                        due_date || null,
                        notes || null,
                        req.admin.username,
                        discountPct,
                    ]
                );

                let sortOrder = 0;
                for (const item of effectiveItems) {
                    const qty = parseFloat(item.quantity) || 1.0;
                    const price = parseFloat(item.unit_price) || 0.0;
                    const itemTotal = parseFloat((qty * price).toFixed(2));
                    db.query(
                        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                        [invoiceId, item.description, qty, price, itemTotal, sortOrder++]
                    );
                }
            });

            await addAuditLog(
                'invoice_created',
                { invoice_id: invoiceId, customer_id, discount_pct: discountPct },
                req.admin.username
            );
            const newInvoice = getInvoiceWithItems(invoiceId);
            res.status(201).json(newInvoice);
        } catch (err) {
            logger.error({ err: err }, '[admin/invoices/create] Error:');
            res.status(500).json({
                success: false,
                message: `Fehler beim Erstellen der Rechnung: ${err.message}`,
            });
        }
    })
);

// ── PUT /invoices/:id ────────────────────────────────────────────────────────
router.put(
    '/invoices/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
        const invoiceId = req.params.id;
        const { items, tax_rate, due_date, notes, type } = req.body;

        const [[invoice]] = db.query(
            'SELECT status, invoice_number, customer_id FROM invoices WHERE id = ?',
            [invoiceId]
        );
        if (!invoice)
            return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });
        if (invoice.status !== 'draft')
            return res.status(400).json({
                success: false,
                message: 'Nur Entwurfs-Rechnungen (draft) können bearbeitet werden.',
            });
        if (!items || !Array.isArray(items) || items.length === 0)
            return res.status(400).json({
                success: false,
                message: 'Mindestens eine Position (item) ist erforderlich.',
            });

        const tax = tax_rate !== undefined ? parseFloat(tax_rate) : 19.0;
        const { amount_net, amount_tax, amount_gross } = calculateInvoiceTotals(items, tax);
        const invType = type || 'invoice';

        try {
            db.runTransaction(() => {
                db.query('DELETE FROM invoice_items WHERE invoice_id = ?', [invoiceId]);

                let sortOrder = 0;
                for (const item of items) {
                    const qty = parseFloat(item.quantity) || 1.0;
                    const price = parseFloat(item.unit_price) || 0.0;
                    const itemTotal = parseFloat((qty * price).toFixed(2));
                    db.query(
                        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                        [invoiceId, item.description, qty, price, itemTotal, sortOrder++]
                    );
                }

                db.query(
                    `UPDATE invoices SET type=?, amount_net=?, amount_tax=?, amount_gross=?, tax_rate=?,
                  due_date=?, notes=?, updated_at=datetime('now') WHERE id=?`,
                    [
                        invType,
                        amount_net,
                        amount_tax,
                        amount_gross,
                        tax,
                        due_date || null,
                        notes || null,
                        invoiceId,
                    ]
                );
            });

            await addAuditLog(
                'invoice_updated',
                { invoice_id: invoiceId, invoice_number: invoice.invoice_number },
                req.admin.username
            );
            res.json(getInvoiceWithItems(invoiceId));
        } catch (err) {
            logger.error({ err: err }, '[admin/invoices/update] Error:');
            res.status(500).json({
                success: false,
                message: `Fehler beim Aktualisieren: ${err.message}`,
            });
        }
    })
);

// ── POST /invoices/:id/mark-paid ─────────────────────────────────────────────
router.post(
    '/invoices/:id/mark-paid',
    requireAuth,
    asyncHandler(async (req, res) => {
        const invoiceId = req.params.id;
        const paidDate = toDbDate(req.body.paid_at ? new Date(req.body.paid_at) : new Date());

        const [[invoice]] = db.query(
            'SELECT invoice_number, customer_id FROM invoices WHERE id = ?',
            [invoiceId]
        );
        if (!invoice)
            return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });

        try {
            db.runTransaction(() => {
                db.query("UPDATE invoices SET status='paid', paid_at=? WHERE id=?", [
                    paidDate,
                    invoiceId,
                ]);
                db.query("UPDATE customers SET payment_status='paid' WHERE id=?", [
                    invoice.customer_id,
                ]);
            });
            await addAuditLog(
                'invoice_paid',
                {
                    invoice_id: invoiceId,
                    invoice_number: invoice.invoice_number,
                    customer_id: invoice.customer_id,
                },
                req.admin.username
            );
            res.json({ success: true, message: 'Rechnung erfolgreich als bezahlt markiert.' });
        } catch (err) {
            logger.error({ err: err }, '[admin/invoices/mark-paid] Error:');
            res.status(500).json({
                success: false,
                message: `Fehler beim Markieren als bezahlt: ${err.message}`,
            });
        }
    })
);

// ── DELETE /invoices/:id ─────────────────────────────────────────────────────
router.delete(
    '/invoices/:id',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
        const [[invoice]] = db.query(
            'SELECT status, invoice_number, pdf_path FROM invoices WHERE id = ?',
            [req.params.id]
        );
        if (!invoice)
            return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });
        if (invoice.status !== 'draft' && invoice.status !== 'cancelled')
            return res.status(400).json({
                success: false,
                message:
                    'Nur Rechnungen im Entwurfs- (draft) oder abgebrochenen (cancelled) Status können gelöscht werden.',
            });

        db.query('DELETE FROM invoices WHERE id = ?', [req.params.id]);
        if (invoice.pdf_path && fs.existsSync(invoice.pdf_path)) {
            try {
                fs.unlinkSync(invoice.pdf_path);
            } catch (err) {
                logger.warn({ err: err }, '[admin/invoices/delete] Could not delete PDF file:');
            }
        }
        await addAuditLog(
            'invoice_deleted',
            { invoice_id: req.params.id, invoice_number: invoice.invoice_number },
            req.admin.username
        );
        res.json({ success: true, message: 'Rechnung erfolgreich gelöscht.' });
    })
);

export default router;
