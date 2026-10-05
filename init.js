#!/usr/bin/env node
/**
 * First-run initializer.
 * Generates .env with cryptographically secure random secrets if not configured.
 * Safe to run multiple times – no-ops when already complete.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const C = (s) => `\x1b[36m${s}\x1b[0m`;
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;

const UNSAFE = new Set([
    '',
    'aendere_mich_sofort',
    'aendere_mich_sofort_hmac',
    'aendere_mich_sofort_portal',
    'change-me-in-production',
    'hmac-change-me-in-production',
    'once_setup_key_123',
]);

function parseEnv(text) {
    const env = {};
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i < 1) continue;
        env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
}

function isUnsafe(v) {
    return !v || UNSAFE.has(v);
}
function genSecret(bytes = 48) {
    return crypto.randomBytes(bytes).toString('hex');
}

function genRsa() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return {
        private: privateKey.replace(/\n/g, '\\n'),
        public: publicKey.replace(/\n/g, '\\n'),
    };
}

function buildFreshEnv(vals, port) {
    return `# Tafeline License Server – Konfiguration
# Automatisch generiert am ${new Date().toISOString().slice(0, 19).replace('T', ' ')}

PORT=${port}
DB_PATH=./data/licens.db
STORAGE_PATH=./storage

ADMIN_SECRET=${vals.ADMIN_SECRET}
HMAC_SECRET=${vals.HMAC_SECRET}
PORTAL_SECRET=${vals.PORTAL_SECRET}

RSA_PRIVATE_KEY=${vals.RSA_PRIVATE_KEY}
RSA_PUBLIC_KEY=${vals.RSA_PUBLIC_KEY}

SETUP_TOKEN=${vals.SETUP_TOKEN}

PORTAL_URL=http://localhost:${port}
APP_URL=http://localhost:${port}
CORS_ORIGINS=

# SMTP (optional – über Admin-Panel konfigurierbar)
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=
# SMTP_PASS=
# SMTP_FROM=noreply@localhost
`;
}

function patchEnv(content, updates) {
    let out = content;
    for (const [key, val] of Object.entries(updates)) {
        const rx = new RegExp(`^(# *)?${key}=.*$`, 'm');
        if (rx.test(out)) {
            out = out.replace(rx, `${key}=${val}`);
        } else {
            out += `\n${key}=${val}\n`;
        }
    }
    return out;
}

// ── Read existing .env ───────────────────────────────────────────────────────
const isFirstRun = !fs.existsSync(ENV_PATH);
const existingText = isFirstRun ? '' : fs.readFileSync(ENV_PATH, 'utf8');
const env = isFirstRun ? {} : parseEnv(existingText);

// ── Decide what needs generating ─────────────────────────────────────────────
const NEED_RANDOM = ['ADMIN_SECRET', 'HMAC_SECRET', 'PORTAL_SECRET', 'SETUP_TOKEN'];
const missing = NEED_RANDOM.filter((k) => isUnsafe(env[k]));
const needsRsa = !env.RSA_PRIVATE_KEY || !env.RSA_PUBLIC_KEY;

if (!isFirstRun && missing.length === 0 && !needsRsa) {
    process.exit(0); // Already fully configured – nothing to do
}

// ── Generate missing values ───────────────────────────────────────────────────
const updates = {};
for (const k of missing) {
    updates[k] = k === 'SETUP_TOKEN' ? genSecret(32) : genSecret(48);
}
if (needsRsa) {
    const rsa = genRsa();
    updates.RSA_PRIVATE_KEY = rsa.private;
    updates.RSA_PUBLIC_KEY = rsa.public;
}

// ── Write .env ────────────────────────────────────────────────────────────────
const port = env.PORT || '4000';
let newContent;
if (isFirstRun) {
    const allVals = { ...env, ...updates };
    newContent = buildFreshEnv(allVals, port);
} else {
    newContent = patchEnv(existingText, updates);
}
fs.writeFileSync(ENV_PATH, newContent, { mode: 0o600 });

// ── Print setup instructions ──────────────────────────────────────────────────
const finalEnv = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
const finalPort = finalEnv.PORT || '4000';

console.log('');
console.log(B(C('  ╔══════════════════════════════════════════════════════╗')));
console.log(B(C('  ║   Tafeline License Server – Ersteinrichtung           ║')));
console.log(B(C('  ╚══════════════════════════════════════════════════════╝')));
console.log('');

if (isFirstRun) {
    console.log(`  ${G('✓')}  .env erstellt – alle Secrets automatisch generiert`);
} else {
    console.log(
        `  ${G('✓')}  .env aktualisiert (${Object.keys(updates).length} fehlende Secrets generiert)`
    );
}

console.log('');
console.log(`  ${B('Setup jetzt im Browser abschließen:')}`);
console.log('');
console.log(`    ${B(C(`http://localhost:${finalPort}/setup`))}`);
console.log('');
console.log(D('  ──────────────────────────────────────────────────────'));
console.log(D(`  Setup-Token (für direkten API-Aufruf): ${finalEnv.SETUP_TOKEN}`));
console.log(D('  ──────────────────────────────────────────────────────'));
console.log('');
