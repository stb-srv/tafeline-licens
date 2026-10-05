import crypto from 'crypto';
import db from './db.js';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const RETRY_DELAYS = [0, 5 * 60 * 1000, 30 * 60 * 1000]; // 0, 5min, 30min

function logWebhookCall(url, event, status, errorMessage = null, attemptCount = 1) {
    try {
        db.query(
            `INSERT INTO webhook_logs (id, webhook_url, event, status, error_message, attempt_count, attempted_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
            [crypto.randomUUID(), url, event, status, errorMessage, attemptCount]
        );
    } catch (e) {
        console.error('❌ Fehler beim Schreiben des Webhook-Logs:', e.message);
    }
}

function matchesEvent(subscribedEvents, event) {
    try {
        const list =
            typeof subscribedEvents === 'string' ? JSON.parse(subscribedEvents) : subscribedEvents;
        if (!Array.isArray(list) || list.includes('*')) return true;
        return list.some((e) => e === event || event.startsWith(e.replace('*', '')));
    } catch {
        return true;
    }
}

async function sendWithRetry(url, secret, body, event) {
    for (let attempt = 1; attempt <= RETRY_DELAYS.length; attempt++) {
        if (RETRY_DELAYS[attempt - 1] > 0)
            await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1]));
        try {
            const sig = secret
                ? crypto.createHmac('sha256', secret).update(body).digest('hex')
                : null;
            const headers = { 'Content-Type': 'application/json' };
            if (sig) headers['X-TAFELINE-Signature'] = sig;
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body,
                signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
            logWebhookCall(url, event, 'success', null, attempt);
            return;
        } catch (e) {
            if (attempt === RETRY_DELAYS.length) {
                console.warn(
                    `⚠️  Webhook ${url} nach ${attempt} Versuchen fehlgeschlagen:`,
                    e.message
                );
                logWebhookCall(url, event, 'failed', e.message, attempt);
                try {
                    db.query(
                        `INSERT INTO webhook_dead_letters (id, webhook_url, event, payload, error, attempt_count)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [crypto.randomUUID(), url, event, body, e.message, attempt]
                    );
                } catch {
                    /* non-critical */
                }
            }
        }
    }
}

export async function fireWebhook(event, payload) {
    const targets = [];
    if (process.env.WEBHOOK_URL)
        targets.push({ url: process.env.WEBHOOK_URL, secret: WEBHOOK_SECRET, events: ['*'] });
    try {
        const [rows] = db.query('SELECT url, secret, events FROM webhooks WHERE active = 1');
        for (const r of rows) targets.push({ url: r.url, secret: r.secret, events: r.events });
    } catch {
        /* webhooks-Tabelle evtl. nicht vorhanden – nur ENV-Target verwenden */
    }

    const body = JSON.stringify({ event, ts: new Date().toISOString(), ...payload });
    for (const { url, secret, events } of targets) {
        if (!matchesEvent(events, event)) continue;
        sendWithRetry(url, secret, body, event).catch(() => {});
    }
}

export async function retryDeadLetter(id) {
    const [[dl]] = db.query('SELECT * FROM webhook_dead_letters WHERE id = ? AND resolved = 0', [
        id,
    ]);
    if (!dl) throw new Error('Dead letter not found or already resolved.');
    const [rows] = db.query('SELECT secret FROM webhooks WHERE url = ? AND active = 1', [
        dl.webhook_url,
    ]);
    const secret = rows[0]?.secret || WEBHOOK_SECRET;
    try {
        const sig = secret
            ? crypto.createHmac('sha256', secret).update(dl.payload).digest('hex')
            : null;
        const headers = { 'Content-Type': 'application/json' };
        if (sig) headers['X-TAFELINE-Signature'] = sig;
        const response = await fetch(dl.webhook_url, {
            method: 'POST',
            headers,
            body: dl.payload,
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        db.query(
            "UPDATE webhook_dead_letters SET resolved = 1, retried_at = datetime('now') WHERE id = ?",
            [id]
        );
    } catch (e) {
        db.query("UPDATE webhook_dead_letters SET retried_at = datetime('now') WHERE id = ?", [id]);
        throw e;
    }
}
