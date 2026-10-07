import { generateSync } from 'otplib';
import { newTotpSecret, totpUri, verifyTotp } from '../server/totp.js';

describe('totp', () => {
    const secret = newTotpSecret();

    test('akzeptiert aktuellen Code', () => {
        expect(verifyTotp(generateSync({ secret }), secret)).toBe(true);
    });

    test('lehnt falschen, leeren und kaputten Input ab', () => {
        expect(verifyTotp('000000', secret)).toBe(false);
        expect(verifyTotp(undefined, secret)).toBe(false);
        expect(verifyTotp('123456', 'kein-secret!')).toBe(false);
    });

    test('otpauth-URI enthält Aussteller, Label und Secret', () => {
        const uri = totpUri('chef', 'Tafeline', secret);
        expect(uri).toMatch(/^otpauth:\/\/totp\/Tafeline:chef\?/);
        expect(uri).toContain(`secret=${secret}`);
    });
});
