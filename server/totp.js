import { generateSecret, generateURI, verifySync } from 'otplib';

export const newTotpSecret = () => generateSecret();

export const totpUri = (label, issuer, secret) => generateURI({ issuer, label, secret });

/** Prüft einen 6-stelligen Code; jede Fehleingabe (auch kaputte Secrets) ergibt false. */
export function verifyTotp(code, secret) {
    try {
        return verifySync({ token: String(code ?? '').trim(), secret }).valid === true;
    } catch {
        return false;
    }
}
