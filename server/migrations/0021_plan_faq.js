export function up(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS plan_pricing (
            plan_id     TEXT NOT NULL PRIMARY KEY,
            label       TEXT NOT NULL,
            description TEXT,
            price       REAL NOT NULL DEFAULT 0,
            currency    TEXT NOT NULL DEFAULT 'EUR',
            features    TEXT DEFAULT '[]',
            active      INTEGER NOT NULL DEFAULT 1,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            updated_at  TEXT DEFAULT (datetime('now'))
        );
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS faq (
            id          TEXT NOT NULL PRIMARY KEY,
            question    TEXT NOT NULL,
            answer      TEXT NOT NULL,
            category    TEXT DEFAULT 'Allgemein',
            sort_order  INTEGER NOT NULL DEFAULT 0,
            active      INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT DEFAULT (datetime('now')),
            updated_at  TEXT DEFAULT (datetime('now'))
        );
    `);

    // Standard-Pläne seeden (nur wenn noch nicht vorhanden)
    const plans = [
        [
            'FREE',
            'Free',
            'Dauerhaft kostenlos – ideal zum Kennenlernen des Systems.',
            0,
            'EUR',
            JSON.stringify([
                '30 Gerichte im Menü',
                '5 Tische',
                'Telefonische Reservierungen',
                'Grundlegendes Menü-System',
                'Community Support',
            ]),
            1,
            0,
        ],
        [
            'STARTER',
            'Basic',
            'Für kleine Betriebe mit Wachstumsambitionen.',
            29,
            'EUR',
            JSON.stringify([
                '60 Gerichte im Menü',
                '10 Tische',
                'Mehrsprachiges Menü (DE/EN)',
                'Küchen-Bestellsystem',
                'Telefonische Reservierungen',
                'E-Mail Support',
            ]),
            1,
            1,
        ],
        [
            'PRO',
            'Pro',
            'Voller Funktionsumfang für wachsende Restaurants.',
            59,
            'EUR',
            JSON.stringify([
                '150 Gerichte im Menü',
                '25 Tische',
                'Online-Reservierungen',
                '5 Menü-Sprachen',
                'QR-Pay Integration',
                'Eigenes Branding',
                'Küchen-Display',
                'Prioritäts-Support',
            ]),
            1,
            2,
        ],
        [
            'ENTERPRISE',
            'Enterprise',
            'Maximale Leistung für große Betriebe und Ketten.',
            199,
            'EUR',
            JSON.stringify([
                'Unbegrenzte Gerichte',
                'Unbegrenzte Tische',
                'Alle Pro-Features',
                'Analytics Dashboard',
                'Saisonale Speisekarten',
                'Dedicated Support',
                'Individuelle Anpassungen',
            ]),
            1,
            3,
        ],
        [
            'TRIAL',
            'Trial',
            '30 Tage kostenlos alle Funktionen testen.',
            0,
            'EUR',
            JSON.stringify(['Alle Pro-Features', '30 Tage gültig', 'Keine Kreditkarte nötig']),
            0,
            4,
        ],
        [
            'PRO_PLUS',
            'Pro+',
            'Erweiterte Kapazitäten und Analytics.',
            89,
            'EUR',
            JSON.stringify([
                '300 Gerichte',
                '50 Tische',
                'Analytics Dashboard',
                'Alle Pro-Features',
            ]),
            0,
            5,
        ],
    ];
    for (const [
        plan_id,
        label,
        description,
        price,
        currency,
        features,
        active,
        sort_order,
    ] of plans) {
        db.prepare(
            'INSERT OR IGNORE INTO plan_pricing (plan_id,label,description,price,currency,features,active,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        ).run(plan_id, label, description, price, currency, features, active, sort_order);
    }

    // Standard-FAQ seeden
    const faqs = [
        [
            'faq-1',
            'Was bedeutet "Bis zu X Tische"?',
            'Die Tischanzahl bestimmt, wie viele Tische gleichzeitig im System verwaltet werden können. Ein Tisch entspricht einem Sitzplatz-Bereich (z.B. Tisch 1–5 im Innenbereich). Bei Überschreitung werden neue Tische nicht mehr angelegt – ein Upgrade ist jederzeit möglich.',
            'Lizenz & Pläne',
            0,
        ],
        [
            'faq-2',
            'Was bedeutet "X Gerichte im Menü"?',
            'Die Gerichte-Anzahl bezieht sich auf die aktiven Einträge in deiner digitalen Speisekarte. Archivierte oder saisonale Gerichte zählen nicht dazu. Der Free-Plan erlaubt 30 aktive Gerichte, was für kleine Karten (z.B. Pizzeria oder Imbiss) ausreicht.',
            'Lizenz & Pläne',
            1,
        ],
        [
            'faq-3',
            'Wie funktioniert die Lizenz-Aktivierung?',
            'Nach der Bestellung erhältst du eine Rechnung per E-Mail. Sobald die Zahlung eingegangen ist, wird deine Lizenz von uns aktiviert – du siehst den Status direkt im Kunden-Portal. Der Lizenz-Key muss anschließend in deiner Tafeline Installation hinterlegt werden.',
            'Lizenz & Pläne',
            2,
        ],
        [
            'faq-4',
            'Kann ich meinen Plan jederzeit wechseln?',
            'Ja – ein Upgrade ist jederzeit möglich. Nimm einfach Kontakt zu uns auf oder bestelle den neuen Plan direkt im Portal. Die verbleibende Laufzeit deines aktuellen Plans wird anteilig angerechnet.',
            'Lizenz & Pläne',
            3,
        ],
        [
            'faq-5',
            'Was passiert wenn meine Lizenz abläuft?',
            'Du erhältst 30 und 7 Tage vor Ablauf eine automatische Erinnerungs-E-Mail. Nach Ablauf wechselt die Lizenz in den "Abgelaufen"-Status – das System funktioniert eingeschränkt (Lesemodus). Daten gehen nicht verloren. Eine Verlängerung ist jederzeit möglich.',
            'Abrechnung',
            4,
        ],
        [
            'faq-6',
            'Wie wird abgerechnet?',
            'Alle Pläne werden jährlich abgerechnet. Du erhältst eine PDF-Rechnung per E-Mail. Wir akzeptieren Überweisung (SEPA). Es gibt keine automatische Verlängerung – du entscheidest jedes Jahr neu.',
            'Abrechnung',
            5,
        ],
        [
            'faq-7',
            'Benötige ich eine eigene Domain?',
            'Ja – jede Lizenz ist an eine Domain gebunden (z.B. meinrestaurant.de). So wird sichergestellt, dass die Lizenz nur auf deiner Installation genutzt wird. Die Domain kannst du jederzeit im Kunden-Portal ändern.',
            'Technik',
            6,
        ],
        [
            'faq-8',
            'Was ist das Kunden-Portal?',
            'Das Kunden-Portal ist dein persönlicher Bereich auf diesem Lizenzserver. Dort kannst du deine Lizenzen einsehen, Domains binden, Rechnungen herunterladen und neue Pläne bestellen. Login unter: /portal.html',
            'Allgemein',
            7,
        ],
    ];
    for (const [id, question, answer, category, sort_order] of faqs) {
        db.prepare(
            'INSERT OR IGNORE INTO faq (id,question,answer,category,sort_order) VALUES (?,?,?,?,?)'
        ).run(id, question, answer, category, sort_order);
    }
}

export default up;
