import { Router } from 'express';
import fs from 'fs';
import db from '../../db.js';
import { getInvoiceWithItems } from '../../invoiceHelper.js';
import { getInvoicePDFBuffer } from '../../pdfGenerator.js';
import { addAuditLog, asyncHandler } from '../../helpers.js';
import { requirePortalAuth } from './shared.js';
import logger from '../../logger.js';

const router = Router();

// ── GET /invoices ─────────────────────────────────────────────────────────────
router.get('/invoices', requirePortalAuth, async (req, res) => {
    try {
        const [rows] = db.query(
            `SELECT i.*, c.name AS customer_name, c.company AS customer_company
             FROM invoices i LEFT JOIN customers c ON i.customer_id=c.id
             WHERE i.customer_id=? ORDER BY i.created_at DESC`,
            [req.customer.id]
        );
        res.json({ success: true, invoices: rows });
    } catch (e) {
        logger.error({ err: e }, '[Portal/invoices] Error:');
        res.status(500).json({ success: false, message: 'Fehler beim Laden der Rechnungen.' });
    }
});

// ── GET /invoices/:id/pdf ─────────────────────────────────────────────────────
router.get('/invoices/:id/pdf', requirePortalAuth, async (req, res) => {
    try {
        const invoice = getInvoiceWithItems(req.params.id);
        if (!invoice)
            return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });
        if (invoice.customer_id !== req.customer.id)
            return res.status(403).json({ success: false, message: 'Zugriff verweigert.' });

        const filename = `Rechnung-${invoice.invoice_number}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        if (invoice.pdf_path && fs.existsSync(invoice.pdf_path)) {
            fs.createReadStream(invoice.pdf_path).pipe(res);
        } else {
            const [[settings]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
            res.send(await getInvoicePDFBuffer({ ...settings, ...invoice }));
        }
    } catch (e) {
        logger.error({ err: e }, '[Portal/invoices/pdf] Error:');
        res.status(500).json({ success: false, message: 'Fehler beim Abrufen des PDF-Dokuments.' });
    }
});

// ── Online-Zahlung (Mollie) ───────────────────────────────────────────────────
router.post(
    '/invoices/:id/checkout',
    requirePortalAuth,
    asyncHandler(async (req, res) => {
        const { isPaymentConfigured, createMolliePayment } = await import('../payment.js');
        if (!isPaymentConfigured())
            return res
                .status(503)
                .json({ success: false, message: 'Online-Zahlung ist nicht konfiguriert.' });

        const [[invoice]] = db.query(
            "SELECT * FROM invoices WHERE id = ? AND customer_id = ? AND status NOT IN ('paid','cancelled')",
            [req.params.id, req.customer.id]
        );
        if (!invoice)
            return res
                .status(404)
                .json({ success: false, message: 'Rechnung nicht gefunden oder bereits bezahlt.' });

        const appUrl = (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
        const molliePayment = await createMolliePayment({
            amount: invoice.amount_gross,
            description: `Rechnung ${invoice.invoice_number} – ${req.customer.name}`,
            redirectUrl: `${appUrl}/portal.html?tab=invoices&paid=1`,
            webhookUrl: `${appUrl}/api/v1/payment/webhook`,
            metadata: { invoice_id: invoice.id, customer_id: req.customer.id },
        });

        db.query('UPDATE invoices SET payment_id = ? WHERE id = ?', [molliePayment.id, invoice.id]);
        await addAuditLog('checkout_initiated', {
            invoice_id: invoice.id,
            payment_id: molliePayment.id,
            customer_id: req.customer.id,
        });
        res.json({
            success: true,
            checkout_url: molliePayment._links.checkout.href,
            payment_id: molliePayment.id,
        });
    })
);

export default router;
