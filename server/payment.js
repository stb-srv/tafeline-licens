const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY || '';
const MOLLIE_BASE = 'https://api.mollie.com/v2';

async function mollieRequest(method, path, body = null) {
    if (!MOLLIE_API_KEY) throw new Error('MOLLIE_API_KEY nicht konfiguriert.');
    const res = await fetch(`${MOLLIE_BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${MOLLIE_API_KEY}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(8000),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || json.title || `Mollie HTTP ${res.status}`);
    return json;
}

export async function createMolliePayment({
    amount,
    currency = 'EUR',
    description,
    redirectUrl,
    webhookUrl,
    metadata,
}) {
    return mollieRequest('POST', '/payments', {
        amount: { currency, value: Number(amount).toFixed(2) },
        description,
        redirectUrl,
        webhookUrl,
        metadata,
    });
}

export async function getMolliePayment(paymentId) {
    return mollieRequest('GET', `/payments/${paymentId}`);
}

export function verifyMollieWebhook(receivedId) {
    // Mollie does not use HMAC for webhooks — verification is done by fetching
    // the payment from the API. Validate the id format before making that call.
    return typeof receivedId === 'string' && receivedId.startsWith('tr_');
}

export function isPaymentConfigured() {
    return !!MOLLIE_API_KEY;
}

export const payment = {
    isConfigured: isPaymentConfigured,
    createPayment: createMolliePayment,
    getPayment: getMolliePayment,
    verifyWebhook: verifyMollieWebhook,
};
