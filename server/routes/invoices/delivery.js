import express from 'express';
import db from '../../db.js';
import { requireAuth } from '../../middleware.js';
import { asyncHandler, addAuditLog } from '../../helpers.js';
import { getInvoiceWithItems } from '../../invoiceHelper.js';
import { generateInvoicePDF, getInvoicePDFBuffer } from '../../pdfGenerator.js';
import fs from 'fs';
import path from 'path';
import logger from '../../logger.js';

const router = express.Router();

// ── POST /invoices/:id/send ──────────────────────────────────────────────────
router.post(
    '/invoices/:id/send',
    requireAuth,
    asyncHandler(async (req, res) => {
        const invoiceId = req.params.id;
        const invoice = getInvoiceWithItems(invoiceId);
        if (!invoice)
            return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });

        const [[settings]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
        if (!settings)
            return res
                .status(500)
                .json({ success: false, message: 'Rechnungs-Einstellungen fehlen.' });

        const filename = `Rechnung-${invoice.invoice_number}.pdf`;
        const storageDir = path.join(process.env.STORAGE_PATH || './storage', 'invoices');
        const pdfPath = path.join(storageDir, filename);
        await generateInvoicePDF({ ...settings, ...invoice }, pdfPath);

        let mailError = null;
        if (invoice.customer_email) {
            try {
                const portalUrl = (
                    process.env.APP_URL || `http://localhost:${process.env.PORT || 4000}`
                ).replace(/\/$/, '');
                const { renderTemplate } = await import('../mailer/templates.js');
                const { sendMail } = await import('../mailer/index.js');
                const { subject, html, text } = renderTemplate('invoiceSent', {
                    customer_name: invoice.customer_name,
                    invoice_number: invoice.invoice_number,
                    amount_gross: invoice.amount_gross,
                    due_date: invoice.due_date,
                    invoice_url: `${portalUrl}/portal.html?tab=invoices`,
                });
                await sendMail({
                    to: invoice.customer_email,
                    subject,
                    html,
                    text,
                    attachments: [{ filename, path: pdfPath, contentType: 'application/pdf' }],
                });
            } catch (mailErr) {
                mailError = mailErr.message;
                logger.error({ err: mailErr }, '[admin/invoices/send] Email failed:');
            }
        } else {
            mailError = 'Kunde hat keine E-Mail-Adresse hinterlegt.';
        }

        db.query(
            `UPDATE invoices SET status='sent', sent_at=datetime('now'), pdf_path=? WHERE id=?`,
            [pdfPath, invoiceId]
        );
        await addAuditLog(
            'invoice_sent',
            {
                invoice_id: invoiceId,
                invoice_number: invoice.invoice_number,
                customer_id: invoice.customer_id,
                mail_error: mailError,
            },
            req.admin.username
        );
        res.json({
            success: true,
            pdf_path: pdfPath,
            mail_sent: !mailError,
            mail_error: mailError || undefined,
            message: mailError
                ? `Rechnung als gesendet markiert. ⚠ E-Mail konnte nicht gesendet werden: ${mailError}`
                : 'Rechnung als gesendet markiert und E-Mail erfolgreich verschickt.',
        });
    })
);

// ── POST /invoices/:id/resend ────────────────────────────────────────────────
router.post(
    '/invoices/:id/resend',
    requireAuth,
    asyncHandler(async (req, res) => {
        const invoiceId = req.params.id;
        const invoice = getInvoiceWithItems(invoiceId);
        if (!invoice)
            return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });
        // Auch Entwürfe können gesendet werden (erster Versand)
        if (!['draft', 'sent', 'overdue', 'paid'].includes(invoice.status))
            return res.status(400).json({
                success: false,
                message: 'Rechnung kann in diesem Status nicht gesendet werden.',
            });

        const [[settings]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
        if (!settings)
            return res
                .status(500)
                .json({ success: false, message: 'Rechnungs-Einstellungen fehlen.' });

        const filename = `Rechnung-${invoice.invoice_number}.pdf`;
        const storageDir = path.join(process.env.STORAGE_PATH || './storage', 'invoices');
        const pdfPath = path.join(storageDir, filename);
        // Immer neu generieren – stellt sicher dass aktuelle Daten und Positionen drin sind
        await generateInvoicePDF({ ...settings, ...invoice }, pdfPath);

        let mailError = null;
        if (invoice.customer_email) {
            try {
                const portalUrl = (
                    process.env.APP_URL || `http://localhost:${process.env.PORT || 4000}`
                ).replace(/\/$/, '');
                const { renderTemplate } = await import('../mailer/templates.js');
                const { sendMail } = await import('../mailer/index.js');
                const { subject, html, text } = renderTemplate('invoiceSent', {
                    customer_name: invoice.customer_name,
                    invoice_number: invoice.invoice_number,
                    amount_gross: invoice.amount_gross,
                    due_date: invoice.due_date,
                    invoice_url: `${portalUrl}/portal.html?tab=invoices`,
                    pdf_download_link: `${portalUrl}/portal.html?tab=invoices`,
                });
                await sendMail({
                    to: invoice.customer_email,
                    subject,
                    html,
                    text,
                    attachments: [{ filename, path: pdfPath, contentType: 'application/pdf' }],
                });
            } catch (mailErr) {
                mailError = mailErr.message;
                logger.error({ err: mailErr }, '[admin/invoices/resend] Email failed:');
            }
        } else {
            mailError = 'Kunde hat keine E-Mail-Adresse hinterlegt.';
        }

        // Status auf 'sent' setzen (auch wenn vorher 'draft')
        db.query(
            `UPDATE invoices SET status='sent', sent_at=COALESCE(sent_at,datetime('now')),
         resent_at=datetime('now'), resent_count=COALESCE(resent_count,0)+1, pdf_path=? WHERE id=?`,
            [pdfPath, invoiceId]
        );
        const newResentCount = (invoice.resent_count || 0) + 1;
        await addAuditLog(
            'invoice_resent',
            {
                invoice_id: invoiceId,
                invoice_number: invoice.invoice_number,
                customer_id: invoice.customer_id,
                resent_count: newResentCount,
                mail_error: mailError,
            },
            req.admin.username
        );
        res.json({
            success: true,
            resent_count: newResentCount,
            mail_sent: !mailError,
            mail_error: mailError || undefined,
            message: mailError
                ? `Rechnung als gesendet markiert. ⚠ E-Mail konnte nicht gesendet werden: ${mailError}`
                : 'Rechnung erfolgreich gesendet.',
        });
    })
);

// ── GET /invoices/:id/pdf ────────────────────────────────────────────────────
router.get(
    '/invoices/:id/pdf',
    requireAuth,
    asyncHandler(async (req, res) => {
        const invoice = getInvoiceWithItems(req.params.id);
        if (!invoice)
            return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });

        const filename = `Rechnung-${invoice.invoice_number}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        if (invoice.pdf_path && fs.existsSync(invoice.pdf_path)) {
            fs.createReadStream(invoice.pdf_path).pipe(res);
        } else {
            const [[settings]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
            res.send(await getInvoicePDFBuffer({ ...settings, ...invoice }));
        }
    })
);

export default router;
