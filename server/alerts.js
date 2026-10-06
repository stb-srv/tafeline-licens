import logger from './logger.js';
import { sendMail } from './mailer/index.js';

/**
 * Meldet ein Betriebsproblem (z. B. fehlgeschlagenes Backup).
 * Immer ins Log; zusätzlich per E-Mail (ALERT_EMAIL) und/oder Webhook (ALERT_WEBHOOK_URL), falls gesetzt.
 * Wirft nie: ein Alarm darf den aufrufenden Job nicht abbrechen.
 */
export async function sendAlert(subject, message) {
    logger.error({ subject }, `🚨 ALARM: ${message}`);
    const email = process.env.ALERT_EMAIL;
    const hook = process.env.ALERT_WEBHOOK_URL;
    if (email) {
        try {
            await sendMail({
                to: email,
                subject: `[Tafeline Lizenzserver] ${subject}`,
                text: message,
            });
        } catch (err) {
            logger.warn({ err }, 'Alarm-Mail konnte nicht gesendet werden.');
        }
    }
    if (hook) {
        try {
            await fetch(hook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subject, message, text: `${subject}: ${message}` }),
                signal: AbortSignal.timeout(10000),
            });
        } catch (err) {
            logger.warn({ err }, 'Alarm-Webhook konnte nicht aufgerufen werden.');
        }
    }
}
