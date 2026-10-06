import { jest } from '@jest/globals';

jest.unstable_mockModule('../server/mailer/index.js', () => ({
    sendMail: jest.fn().mockRejectedValue(new Error('smtp down')),
}));
const { sendAlert } = await import('../server/alerts.js');
const { sendMail } = await import('../server/mailer/index.js');

afterEach(() => {
    delete process.env.ALERT_EMAIL;
    delete process.env.ALERT_WEBHOOK_URL;
    jest.restoreAllMocks();
});

describe('sendAlert', () => {
    test('wirft nie, auch wenn Mail und Webhook scheitern', async () => {
        process.env.ALERT_EMAIL = 'a@b.de';
        process.env.ALERT_WEBHOOK_URL = 'http://hook.invalid/x';
        global.fetch = jest.fn().mockRejectedValue(new Error('net'));
        await expect(sendAlert('Test', 'msg')).resolves.toBeUndefined();
        expect(sendMail).toHaveBeenCalled();
        expect(global.fetch).toHaveBeenCalled();
    });

    test('ohne Konfiguration nur Log', async () => {
        sendMail.mockClear();
        await sendAlert('Test', 'msg');
        expect(sendMail).not.toHaveBeenCalled();
    });
});
