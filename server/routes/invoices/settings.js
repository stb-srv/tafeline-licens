import express from 'express';
import db from '../../db.js';
import { requireAuth } from '../../middleware.js';
import { asyncHandler, addAuditLog } from '../../helpers.js';
import { getInvoicePDFBuffer } from '../../pdfGenerator.js';

const router = express.Router();

// ── GET /invoice-settings ────────────────────────────────────────────────────
router.get(
    '/invoice-settings',
    requireAuth,
    asyncHandler(async (req, res) => {
        const [[settings]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
        if (!settings)
            return res
                .status(404)
                .json({ success: false, message: 'Rechnungs-Einstellungen nicht gefunden.' });
        res.json(settings);
    })
);

// ── PUT /invoice-settings ────────────────────────────────────────────────────
router.put(
    '/invoice-settings',
    requireAuth,
    asyncHandler(async (req, res) => {
        const {
            company_name,
            company_address,
            company_tax_id,
            company_iban,
            company_bic,
            company_bank_name,
            invoice_prefix,
            logo_path,
            footer_text,
        } = req.body;
        if (!company_name || !company_address)
            return res.status(400).json({
                success: false,
                message: 'company_name und company_address sind Pflichtfelder.',
            });

        db.query(
            `UPDATE invoice_settings SET company_name=?, company_address=?, company_tax_id=?,
          company_iban=?, company_bic=?, company_bank_name=?, invoice_prefix=?, logo_path=?, footer_text=?,
          updated_at=datetime('now')
         WHERE id=1`,
            [
                company_name,
                company_address,
                company_tax_id || null,
                company_iban || null,
                company_bic || null,
                company_bank_name || null,
                invoice_prefix || 'INV',
                logo_path || null,
                footer_text || null,
            ]
        );

        await addAuditLog(
            'invoice_settings_updated',
            { by: req.admin.username },
            req.admin.username
        );
        const [[updated]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
        res.json(updated);
    })
);

// ── GET /invoice-settings/preview-pdf ────────────────────────────────────────
router.get(
    '/invoice-settings/preview-pdf',
    requireAuth,
    asyncHandler(async (req, res) => {
        const [[settings]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
        if (!settings)
            return res
                .status(404)
                .json({ success: false, message: 'Einstellungen nicht gefunden.' });

        const previewData = {
            ...settings,
            invoice_number: `${settings.invoice_prefix || 'INV'}-${new Date().getFullYear()}-VORSCHAU`,
            type: 'invoice',
            created_at: new Date().toISOString(),
            due_date: new Date(Date.now() + 30 * 86400000).toISOString(),
            customer_name: 'Max Mustermann',
            customer_company: 'Musterfirma GmbH',
            customer_billing_street: 'Musterstraße 42',
            customer_billing_zip: '12345',
            customer_billing_city: 'Musterstadt',
            customer_billing_country: 'Deutschland',
            amount_net: 84.03,
            amount_tax: 15.97,
            amount_gross: 100.0,
            tax_rate: 19,
            notes: 'Dies ist eine Vorschau-Rechnung.',
            items: [
                {
                    description: 'Lizenzgebühr PRO – example.de',
                    quantity: 1,
                    unit_price: 59.0,
                    total: 59.0,
                },
                {
                    description: 'Lizenzgebühr STARTER – demo.de',
                    quantity: 1,
                    unit_price: 25.03,
                    total: 25.03,
                },
            ],
        };

        try {
            const buf = await getInvoicePDFBuffer(previewData);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'inline; filename="Vorschau-Rechnung.pdf"');
            res.send(buf);
        } catch (e) {
            res.status(500).json({ success: false, message: `PDF-Fehler: ${e.message}` });
        }
    })
);

// ── Export Invoices ───────────────────────────────────────────────────────────
router.get(
    '/export/invoices',
    requireAuth,
    asyncHandler(async (req, res) => {
        const format = req.query.format === 'json' ? 'json' : 'csv';
        const [rows] = db.query(
            `SELECT i.id, i.invoice_number, i.status, i.type, i.customer_id,
                c.name AS customer_name, c.email AS customer_email,
                i.license_key, i.amount_net, i.amount_tax, i.amount_gross, i.tax_rate,
                i.due_date, i.paid_at, i.created_at, i.dunning_level
         FROM invoices i
         LEFT JOIN customers c ON i.customer_id = c.id
         ORDER BY i.created_at DESC`
        );
        if (format === 'json') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename=invoices_export.json');
            return res.send(JSON.stringify(rows, null, 2));
        }
        const headers = [
            'id',
            'invoice_number',
            'status',
            'type',
            'customer_name',
            'customer_email',
            'license_key',
            'amount_net',
            'amount_tax',
            'amount_gross',
            'tax_rate',
            'due_date',
            'paid_at',
            'created_at',
            'dunning_level',
        ];
        let csv = headers.join(';') + '\n';
        for (const row of rows) {
            const line = headers.map((h) => `"${String(row[h] ?? '').replace(/"/g, '""')}"`);
            csv += line.join(';') + '\n';
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=invoices_export.csv');
        res.send('﻿' + csv);
    })
);

export default router;
