/**
 * server/mailer/templates.js
 * HTML-E-Mail-Templates für den Tafeline Lizenzserver.
 */

function layout(title, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f2f5;padding:32px 0">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">
          <tr>
            <td style="background:linear-gradient(135deg,#6c63ff 0%,#5a52d5 100%);border-radius:12px 12px 0 0;padding:28px 32px">
              <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.3px">
                &#9889; Tafeline Lizenzserver
              </h1>
            </td>
          </tr>
          <tr>
            <td style="background:#fff;padding:32px;border-left:1px solid #e8e8f0;border-right:1px solid #e8e8f0">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="background:#f8f8fc;border:1px solid #e8e8f0;border-top:none;border-radius:0 0 12px 12px;padding:18px 32px;text-align:center">
              <p style="margin:0;color:#aaa;font-size:12px">
                Tafeline Lizenzserver &nbsp;&bull;&nbsp; Automatisch generierte E-Mail
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function badge(text, color = '#6c63ff') {
    return `<span style="display:inline-block;background:${color};color:#fff;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600">${text}</span>`;
}

function infoBox(rows) {
    const cells = rows
        .map(
            ([label, value]) =>
                `<tr>
          <td style="padding:8px 0;color:#888;font-size:13px;width:140px;vertical-align:top">${label}</td>
          <td style="padding:8px 0;color:#222;font-size:13px;font-weight:500">${value}</td>
        </tr>`
        )
        .join('');
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0"
      style="background:#f8f8fc;border-radius:8px;padding:16px 20px;margin:20px 0">
      ${cells}
    </table>`;
}

const TEMPLATES = {
    test: (d) => ({
        subject: 'Tafeline \u2014 SMTP Test \u2705',
        html: layout(
            'SMTP Test',
            `
          <h2 style="margin:0 0 12px;font-size:18px;color:#222">SMTP-Test erfolgreich &#9989;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Diese E-Mail best\u00e4tigt, dass deine SMTP-Konfiguration korrekt eingerichtet ist.
          </p>
          ${infoBox([
              ['Gesendet am', new Date().toLocaleString('de-DE')],
              ['SMTP-Server', d.host || 'konfiguriert'],
          ])}
        `
        ),
        text: `Tafeline Lizenzserver — SMTP Test erfolgreich.\n\nGesendet: ${new Date().toLocaleString('de-DE')}`,
    }),

    // Neuer Kunde angelegt — sendet Login-Daten mit automatisch generiertem Benutzernamen
    accountCreated: (d) => ({
        subject: 'Willkommen bei Tafeline \u2014 Deine Zugangsdaten',
        html: layout(
            'Account erstellt',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#222">Willkommen, ${d.name || 'Kunde'}! &#127881;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Dein Zugang zum <strong>Tafeline Kunden-Portal</strong> wurde erfolgreich angelegt.
            Dort kannst du deine Lizenzen einsehen, Domains verwalten und deine Kaufhistorie abrufen.
          </p>

          <!-- Benutzername-Highlight-Box -->
          <div style="background:linear-gradient(135deg,#eff6ff 0%,#dbeafe 100%);border:2px solid #3b82f6;border-radius:10px;padding:18px 22px;margin:0 0 20px">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#1d4ed8;letter-spacing:.1em;text-transform:uppercase">&#128100; Dein Benutzername</p>
            <p style="margin:0;font-size:22px;font-weight:800;color:#1e3a8a;font-family:monospace;letter-spacing:.03em">${d.username || d.email}</p>
            <p style="margin:8px 0 0;font-size:12px;color:#2563eb;line-height:1.5">
              Du kannst dich mit diesem Benutzernamen <strong>oder</strong> deiner E-Mail-Adresse einloggen.
            </p>
          </div>

          ${infoBox([
              ['E-Mail-Adresse', d.email],
              [
                  'Tempor\u00e4res Passwort',
                  `<code style="background:#fff3cd;padding:3px 8px;border-radius:4px;font-size:14px;font-weight:700;color:#856404">${d.password}</code>`,
              ],
              ['Portal-URL', `<a href="${d.login_url}" style="color:#6c63ff">${d.login_url}</a>`],
          ])}

          <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:14px 18px;margin:20px 0">
            <p style="margin:0;color:#856404;font-size:13px;line-height:1.6">
              &#9888;&#65039; <strong>Wichtig:</strong> Bitte \u00e4ndere dein Passwort direkt nach dem ersten Login.
              Du wirst automatisch dazu aufgefordert.
            </p>
          </div>
          <div style="text-align:center;margin:28px 0">
            <a href="${d.login_url}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">
              &#128272; Jetzt einloggen
            </a>
          </div>
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Fragen? Schreib uns an support@stb-srv.de
          </p>
        `
        ),
        text: `Willkommen beim Tafeline Kunden-Portal!\n\nDeine Zugangsdaten:\n\nBenutzername: ${d.username || d.email}\nE-Mail:       ${d.email}\nPasswort:     ${d.password}\n\nDu kannst dich mit dem Benutzernamen ODER der E-Mail-Adresse einloggen.\n\nPortal-URL: ${d.login_url}\n\nWICHTIG: Bitte \u00e4ndere dein Passwort nach dem ersten Login.\n\nBei Fragen: support@stb-srv.de`,
    }),

    portalInvite: (d) => ({
        subject: 'Einladung zum Tafeline Kunden-Portal',
        html: layout(
            'Portal-Einladung',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#222">Willkommen im Kunden-Portal &#127881;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.name || 'Kunde'},<br><br>
            du wurdest eingeladen, auf das <strong>Tafeline Kunden-Portal</strong> zuzugreifen.
            Dort kannst du deine Lizenzen einsehen, Domains binden und deine Kaufhistorie abrufen.
          </p>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Klicke auf den folgenden Button, um ein Passwort zu setzen und dein Konto zu aktivieren.
            Der Link ist <strong>24 Stunden gültig</strong>.
          </p>
          <div style="text-align:center;margin:28px 0">
            <a href="${d.invite_url}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">
              &#128272; Passwort setzen &amp; einloggen
            </a>
          </div>
          ${infoBox([
              ['E-Mail', d.email],
              [
                  'Link gültig bis',
                  new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleString('de-DE'),
              ],
          ])}
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Falls du diese Einladung nicht erwartet hast, ignoriere diese E-Mail.
          </p>
        `
        ),
        text: `Einladung zum Tafeline Kunden-Portal\n\nHallo ${d.name},\n\nHier ist dein Einladungslink:\n${d.invite_url}\n\nDer Link ist 24 Stunden gültig.`,
    }),

    licenseCreated: (d) => ({
        subject: `Deine Tafeline Lizenz ist bereit`,
        html: layout(
            'Lizenz erstellt',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#222">Deine Lizenz ist aktiv &#127881;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            deine Lizenz f\u00fcr <strong>Tafeline</strong> wurde erfolgreich erstellt und ist sofort einsatzbereit.
          </p>
          ${infoBox([
              [
                  'Lizenzschl\u00fcssel',
                  `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`,
              ],
              ['Plan', badge(d.type || 'FREE')],
              [
                  'G\u00fcltig bis',
                  d.expires_at ? new Date(d.expires_at).toLocaleDateString('de-DE') : 'Unbegrenzt',
              ],
              ['Domain', d.associated_domain || '*'],
          ])}
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Du kannst deine Lizenz jederzeit im Kunden-Portal einsehen.
          </p>
        `
        ),
        text: `Lizenz erstellt\n\nLizenzschlüssel: ${d.license_key}\nPlan: ${d.type}\nGültig bis: ${d.expires_at}`,
    }),

    licenseExpiringSoon: (d) => ({
        subject: `Deine Tafeline Lizenz läuft in ${d.days_left || '?'} Tagen ab`,
        html: layout(
            'Lizenz läuft ab',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#e67e22">&#9888;&#65039; Lizenz l\u00e4uft bald ab</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            deine Lizenz l\u00e4uft in <strong>${d.days_left} Tagen</strong> ab.
          </p>
          ${infoBox([
              [
                  'Lizenzschl\u00fcssel',
                  `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`,
              ],
              ['Plan', badge(d.type || 'FREE', '#e67e22')],
              [
                  'L\u00e4uft ab am',
                  d.expires_at ? new Date(d.expires_at).toLocaleDateString('de-DE') : 'unbekannt',
              ],
          ])}
        `
        ),
        text: `Lizenz läuft bald ab\n\nDeine Lizenz läuft in ${d.days_left} Tagen ab.\nLizenzschlüssel: ${d.license_key}`,
    }),

    licenseRenewed: (d) => ({
        subject: 'Deine Lizenz wurde verlängert – Tafeline',
        html: layout(
            'Lizenz verlängert',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#27ae60">Lizenz verl\u00e4ngert &#10003;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            deine Lizenz wurde erfolgreich verlängert.
          </p>
          ${infoBox([
              [
                  'Lizenzschl\u00fcssel',
                  `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`,
              ],
              ['Plan', badge(d.type || 'FREE', '#27ae60')],
              [
                  'Neues Ablaufdatum',
                  d.new_expires_at
                      ? new Date(d.new_expires_at).toLocaleDateString('de-DE')
                      : 'Unbegrenzt',
              ],
              ['Verlängert um', `${d.days} Tage`],
          ])}
        `
        ),
        text: `Lizenz verlängert\n\nNeues Ablaufdatum: ${d.new_expires_at}`,
    }),

    licenseRevoked: (d) => ({
        subject: 'Deine Lizenz wurde gesperrt – Tafeline',
        html: layout(
            'Lizenz widerrufen',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#e74c3c">Lizenz widerrufen &#10060;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            deine Lizenz wurde widerrufen. Bitte wende dich an den Administrator.
          </p>
          ${infoBox([
              [
                  'Lizenzschl\u00fcssel',
                  `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`,
              ],
              ['Grund', d.reason || 'Nicht angegeben'],
          ])}
        `
        ),
        text: `Lizenz widerrufen\n\nLizenzschlüssel: ${d.license_key}\nGrund: ${d.reason || 'Nicht angegeben'}`,
    }),

    // Passwort-Reset angefordert (Kunden-Portal)
    passwordReset: (d) => ({
        subject: 'Passwort zurücksetzen – Tafeline',
        html: layout(
            'Passwort zur\u00fccksetzen',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#222">Passwort zur\u00fccksetzen &#128274;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.name || 'Kunde'},<br><br>
            wir haben eine Anfrage zum Zur\u00fccksetzen deines Passworts f\u00fcr das
            <strong>Tafeline Kunden-Portal</strong> erhalten.
          </p>
          <div style="text-align:center;margin:28px 0">
            <a href="${d.reset_url}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">
              &#128274; Passwort zur\u00fccksetzen
            </a>
          </div>
          ${infoBox([
              [
                  'G\u00fcltig bis',
                  new Date(Date.now() + 2 * 60 * 60 * 1000).toLocaleString('de-DE'),
              ],
              ['Link g\u00fcltig', '2 Stunden'],
          ])}
          <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:14px 18px;margin:20px 0">
            <p style="margin:0;color:#856404;font-size:13px;line-height:1.6">
              &#9888;&#65039; Falls du \u003cstrong\u003ekein\u003c/strong\u003e Passwort-Reset angefordert hast, ignoriere diese E-Mail.
              Dein Passwort bleibt unver\u00e4ndert.
            </p>
          </div>
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Fragen? Schreib uns an support@stb-srv.de
          </p>
        `
        ),
        text: `Passwort zur\u00fccksetzen\n\nHallo ${d.name},\n\nBitte klicke auf folgenden Link um dein Passwort zur\u00fcckzusetzen:\n${d.reset_url}\n\nDer Link ist 2 Stunden g\u00fcltig.\n\nFalls du keinen Reset angefordert hast, ignoriere diese E-Mail.`,
    }),

    trialWelcome: (d) => {
        const expDate = new Date(d.expires_at).toLocaleDateString('de-DE', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
        });
        return {
            subject: `🍽️ Ihr Tafeline Trial ist aktiv – Key: ${d.license_key}`,
            html: layout(
                'Willkommen bei Tafeline',
                `
                <h1 style="color:#1b3a5c; font-size:1.4rem; margin:0 0 16px;">
                    Willkommen bei Tafeline &#127881;
                </h1>
                <p style="margin:0 0 16px; color:#555; line-height:1.7;">Hallo ${d.restaurant_name},</p>
                <p style="margin:0 0 16px; color:#555; line-height:1.7;">Ihr <strong>30-Tage Trial</strong> ist jetzt aktiv. Hier sind Ihre Zugangsdaten:</p>

                <div style="background:#f8fafc; border-radius:12px; padding:20px; margin:24px 0; border-left:4px solid #1b3a5c;">
                    <p style="margin:0 0 8px;"><strong>Lizenz-Key:</strong><br>
                       <code style="font-size:1.1rem; letter-spacing:2px; color:#1b3a5c;">
                         ${d.license_key}
                       </code></p>
                    <p style="margin:8px 0;"><strong>Plan:</strong> ${d.plan_label}</p>
                    <p style="margin:8px 0;"><strong>Domain:</strong> ${d.domain}</p>
                    <p style="margin:8px 0 0;"><strong>Gültig bis:</strong> ${expDate}</p>
                </div>

                <p style="margin:0 0 12px;"><strong>Im Trial enthalten:</strong></p>
                <ul style="margin:0; padding:0 0 0 20px; color:#555; line-height:1.7;">
                    <li>Bis zu ${d.limits.max_dishes} Gerichte</li>
                    <li>Bis zu ${d.limits.max_tables} Tische</li>
                    <li>Küchen-Bestellsystem</li>
                    <li>Telefonische Reservierungen</li>
                </ul>

                <p style="color:#6b7280; font-size:.85rem; margin-top:32px;">
                    Bei Fragen antworten Sie einfach auf diese E-Mail.<br>
                    – Das Tafeline Team
                </p>
            `
            ),
            text: `Willkommen bei Tafeline!\n\nIhr 30-Tage Trial ist jetzt aktiv.\n\nLizenz-Key: ${d.license_key}\nPlan: ${d.plan_label}\nDomain: ${d.domain}\nGültig bis: ${expDate}\n\nBei Fragen: support@stb-srv.de`,
        };
    },

    invoiceSent: (d) => ({
        subject: `Ihre Tafeline Rechnung – ${d.invoice_number}`,
        html: layout(
            'Ihre Rechnung ist bereit',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#222">Hallo ${d.customer_name || 'Kunde'},</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Ihre neue Rechnung <strong>${d.invoice_number}</strong> ist bereit. Sie finden das PDF-Dokument im Anhang dieser E-Mail oder können es direkt in Ihrem Kunden-Portal einsehen und herunterladen.
          </p>
          ${infoBox([
              ['Rechnungsnummer', d.invoice_number],
              ['Gesamtbetrag', `${(parseFloat(d.amount_gross) || 0).toFixed(2)} €`],
              [
                  'Fälligkeitsdatum',
                  d.due_date ? new Date(d.due_date).toLocaleDateString('de-DE') : 'sofort fällig',
              ],
              [
                  'Kunden-Portal',
                  `<a href="${d.invoice_url}" style="color:#6c63ff">Rechnungen ansehen</a>`,
              ],
          ])}
          <div style="text-align:center;margin:28px 0">
            <a href="${d.invoice_url}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">
              💳 Zum Kunden-Portal
            </a>
          </div>
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Vielen Dank für Ihre Treue!<br>
            Das Tafeline Team
          </p>
        `
        ),
        text: `Ihre Tafeline Rechnung ${d.invoice_number} ist da.\n\nGesamtbetrag: ${(parseFloat(d.amount_gross) || 0).toFixed(2)} €\nFälligkeitsdatum: ${d.due_date ? new Date(d.due_date).toLocaleDateString('de-DE') : 'sofort'}\n\nSie finden die Rechnung als PDF im Anhang oder im Kunden-Portal unter: ${d.invoice_url}`,
    }),

    invoiceOverdue: (d) => ({
        subject: `⚠️ DRINGEND: Zahlungserinnerung Rechnung ${d.invoice_number} – Tafeline`,
        html: layout(
            'Zahlungserinnerung',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#e74c3c">Zahlungserinnerung / Mahnung</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            wir haben festgestellt, dass die folgende Rechnung das Fälligkeitsdatum überschritten hat und noch offen ist.
          </p>
          <div style="background:#fde8e8;border:1px solid #f8b4b4;border-radius:8px;padding:14px 18px;margin:20px 0">
            <p style="margin:0;color:#9b1c1c;font-size:13px;line-height:1.6">
              ⚠️ <strong>Wichtiger Hinweis:</strong> Bitte begleichen Sie den ausstehenden Betrag umgehend, um eine Unterbrechung Ihrer Tafeline Lizenz-Dienste zu vermeiden.
            </p>
          </div>
          ${infoBox([
              ['Rechnungsnummer', d.invoice_number],
              ['Gesamtbetrag', `${(parseFloat(d.amount_gross) || 0).toFixed(2)} €`],
              [
                  'Ursprünglich fällig am',
                  d.due_date ? new Date(d.due_date).toLocaleDateString('de-DE') : 'unbekannt',
              ],
              ['Status', badge('ZAHLUNGSVERZUG', '#e74c3c')],
          ])}
          <div style="text-align:center;margin:28px 0">
            <a href="${d.invoice_url}" style="display:inline-block;background:#e74c3c;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">
              💳 Jetzt bezahlen
            </a>
          </div>
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Sollten Sie die Zahlung bereits angewiesen haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.<br>
            Das Tafeline Team
          </p>
        `
        ),
        text: `Dringende Zahlungserinnerung für Rechnung ${d.invoice_number}.\n\nGesamtbetrag: ${(parseFloat(d.amount_gross) || 0).toFixed(2)} €\nFällig war am: ${d.due_date ? new Date(d.due_date).toLocaleDateString('de-DE') : 'sofort'}\n\nBitte begleichen Sie den Betrag umgehend im Kunden-Portal unter: ${d.invoice_url} um eine Sperrung Ihrer Lizenz zu vermeiden.`,
    }),

    licenseExpiring7d: (d) => ({
        subject: `⚠️ ACHTUNG: Deine Tafeline Lizenz läuft in 7 Tagen ab`,
        html: layout(
            'Lizenz läuft in 7 Tagen ab',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#e74c3c">⚠️ Wichtiger Hinweis: Deine Lizenz läuft in 7 Tagen ab!</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            deine Tafeline Lizenz läuft am <strong>${d.expires_at ? new Date(d.expires_at).toLocaleDateString('de-DE') : 'unbekannt'}</strong> (in genau 7 Tagen) ab.
          </p>
          <div style="background:#feecdc;border:1px solid #fbd38d;border-radius:8px;padding:14px 18px;margin:20px 0">
            <p style="margin:0;color:#c05621;font-size:13px;line-height:1.6">
              🚨 <strong>Dringend handeln:</strong> Ohne Verlängerung wird das System nach dem Ablaufdatum für Bestellungen und Reservierungen gesperrt. Bitte verlängere deine Lizenz im Portal, um Ausfälle in deinem Restaurant zu vermeiden.
            </p>
          </div>
          ${infoBox([
              [
                  'Lizenzschlüssel',
                  `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`,
              ],
              ['Plan', badge(d.type || 'FREE', '#e74c3c')],
              [
                  'Ablaufdatum',
                  d.expires_at ? new Date(d.expires_at).toLocaleDateString('de-DE') : 'unbekannt',
              ],
          ])}
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Wende dich bei Fragen direkt an unseren Support.<br>
            Das Tafeline Team
          </p>
        `
        ),
        text: `Deine Tafeline Lizenz läuft am ${d.expires_at ? new Date(d.expires_at).toLocaleDateString('de-DE') : 'unbekannt'} (in 7 Tagen) ab.\n\nBitte verlängere deine Lizenz umgehend im Portal, um Ausfälle in deinem Restaurant zu vermeiden.\n\nLizenzschlüssel: ${d.license_key}`,
    }),

    invoiceDunning1: (d) => ({
        subject: `Zahlungserinnerung: Rechnung ${d.invoice_number} – Tafeline`,
        html: layout(
            'Zahlungserinnerung',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#e67e22">&#128276; Freundliche Zahlungserinnerung</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            wir möchten Sie freundlich daran erinnern, dass die folgende Rechnung noch offen ist.
          </p>
          ${infoBox([
              ['Rechnungsnummer', d.invoice_number],
              ['Gesamtbetrag', `${(parseFloat(d.amount_gross) || 0).toFixed(2)} €`],
              [
                  'Fällig seit',
                  d.due_date ? new Date(d.due_date).toLocaleDateString('de-DE') : 'unbekannt',
              ],
              ['Überfällig seit', `${d.days_overdue} Tag(en)`],
          ])}
          <div style="text-align:center;margin:28px 0">
            <a href="${d.invoice_url}" style="display:inline-block;background:#e67e22;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">
              Rechnung bezahlen
            </a>
          </div>
        `
        ),
        text: `Zahlungserinnerung\n\nRechnung ${d.invoice_number} (${(parseFloat(d.amount_gross) || 0).toFixed(2)} €) ist seit ${d.days_overdue} Tag(en) überfällig.\n\nBitte begleichen Sie den Betrag unter: ${d.invoice_url}`,
    }),

    invoiceDunning2: (d) => ({
        subject: `1. Mahnung: Rechnung ${d.invoice_number} – Tafeline`,
        html: layout(
            '1. Mahnung',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#e74c3c">&#9888;&#65039; 1. Mahnung</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            trotz unserer Zahlungserinnerung ist folgende Rechnung weiterhin unbeglichen.
            Bitte begleichen Sie den Betrag umgehend.
          </p>
          <div style="background:#fde8e8;border:1px solid #f8b4b4;border-radius:8px;padding:14px 18px;margin:20px 0">
            <p style="margin:0;color:#9b1c1c;font-size:13px;line-height:1.6">
              &#9888;&#65039; Bei Nichtbegleichung behalten wir uns vor, Ihre Lizenz-Dienste zu unterbrechen.
            </p>
          </div>
          ${infoBox([
              ['Rechnungsnummer', d.invoice_number],
              ['Gesamtbetrag', `${(parseFloat(d.amount_gross) || 0).toFixed(2)} €`],
              ['Überfällig seit', `${d.days_overdue} Tagen`],
              ['Status', badge('1. MAHNUNG', '#e74c3c')],
          ])}
          <div style="text-align:center;margin:28px 0">
            <a href="${d.invoice_url}" style="display:inline-block;background:#e74c3c;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">
              Jetzt bezahlen
            </a>
          </div>
        `
        ),
        text: `1. Mahnung\n\nRechnung ${d.invoice_number} (${(parseFloat(d.amount_gross) || 0).toFixed(2)} €) ist seit ${d.days_overdue} Tagen überfällig.\n\nBitte bezahlen Sie umgehend unter: ${d.invoice_url}`,
    }),

    invoiceDunning3: (d) => ({
        subject: `2. Mahnung: Rechnung ${d.invoice_number} – Tafeline`,
        html: layout(
            '2. Mahnung',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#c0392b">&#128680; 2. Mahnung – Letzte Warnung</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            wir haben Sie bereits mehrfach auf die offene Zahlung hingewiesen.
            Dies ist unsere letzte Erinnerung vor der Sperrung Ihrer Lizenz.
          </p>
          <div style="background:#fde8e8;border:2px solid #e74c3c;border-radius:8px;padding:14px 18px;margin:20px 0">
            <p style="margin:0;color:#9b1c1c;font-size:13px;font-weight:600;line-height:1.6">
              &#128680; DRINGEND: Ohne Zahlung innerhalb von 7 Tagen wird Ihre Lizenz automatisch gesperrt.
            </p>
          </div>
          ${infoBox([
              ['Rechnungsnummer', d.invoice_number],
              ['Gesamtbetrag', `${(parseFloat(d.amount_gross) || 0).toFixed(2)} €`],
              ['Überfällig seit', `${d.days_overdue} Tagen`],
              ['Status', badge('2. MAHNUNG', '#c0392b')],
          ])}
          <div style="text-align:center;margin:28px 0">
            <a href="${d.invoice_url}" style="display:inline-block;background:#c0392b;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">
              Jetzt bezahlen – Sperrung verhindern
            </a>
          </div>
        `
        ),
        text: `2. Mahnung\n\nRechnung ${d.invoice_number} (${(parseFloat(d.amount_gross) || 0).toFixed(2)} €) ist seit ${d.days_overdue} Tagen überfällig. Ohne Zahlung wird Ihre Lizenz gesperrt.\n\nJetzt bezahlen: ${d.invoice_url}`,
    }),

    invoiceDunningFinal: (d) => ({
        subject: `Lizenz gesperrt – offene Zahlung: Rechnung ${d.invoice_number} – Tafeline`,
        html: layout(
            'Lizenz gesperrt',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#7f1d1d">&#128274; Ihre Lizenz wurde gesperrt</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            aufgrund der anhaltend offenen Zahlung wurde Ihre Lizenz vorübergehend gesperrt.
            Bitte begleichen Sie den Betrag, um den Dienst wiederherzustellen.
          </p>
          <div style="background:#7f1d1d;border-radius:8px;padding:18px 22px;margin:20px 0">
            <p style="margin:0;color:#fff;font-size:13px;font-weight:700;line-height:1.6">
              Ihre Lizenz ist GESPERRT. Der Betrieb ist unterbrochen.
            </p>
          </div>
          ${infoBox([
              ['Rechnungsnummer', d.invoice_number],
              ['Gesamtbetrag', `${(parseFloat(d.amount_gross) || 0).toFixed(2)} €`],
              ['Überfällig seit', `${d.days_overdue} Tagen`],
              ['Status', badge('GESPERRT', '#7f1d1d')],
          ])}
          <div style="text-align:center;margin:28px 0">
            <a href="${d.invoice_url}" style="display:inline-block;background:#7f1d1d;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">
              Jetzt bezahlen – Sperre aufheben
            </a>
          </div>
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Nach Zahlungseingang wird Ihre Lizenz umgehend reaktiviert.
          </p>
        `
        ),
        text: `Lizenz gesperrt\n\nRechnung ${d.invoice_number} (${(parseFloat(d.amount_gross) || 0).toFixed(2)} €) ist seit ${d.days_overdue} Tagen unbezahlt. Ihre Lizenz wurde gesperrt.\n\nJetzt bezahlen: ${d.invoice_url}`,
    }),

    emailVerification: (d) => ({
        subject: 'E-Mail-Adresse bestätigen - Tafeline',
        html: layout(
            'E-Mail-Adresse bestätigen',
            `
          <h2 style="margin:0 0 8px;font-size:18px;color:#222">Hallo ${d.name || 'Kunde'},</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            vielen Dank für deine Registrierung beim <strong>Tafeline Lizenzserver</strong>.
            Bitte klicke auf den folgenden Button, um deine E-Mail-Adresse zu bestätigen und deinen Account zu aktivieren.
            Der Link ist <strong>24 Stunden gültig</strong>.
          </p>
          <div style="text-align:center;margin:28px 0">
            <a href="${d.verify_url}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">
              ✉️ E-Mail-Adresse bestätigen
            </a>
          </div>
          ${infoBox([
              ['E-Mail-Adresse', d.email],
              ['Gültigkeit des Links', '24 Stunden'],
          ])}
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Falls du diese Registrierung nicht vorgenommen hast, kannst du diese E-Mail einfach ignorieren.
          </p>
        `
        ),
        text: `E-Mail-Adresse bestätigen\n\nHallo ${d.name || 'Kunde'},\n\nbitte bestätige deine E-Mail-Adresse, indem du auf folgenden Link klickst:\n${d.verify_url}\n\nDer Link ist 24 Stunden gültig.`,
    }),
};

export function renderTemplate(name, data = {}) {
    const tpl = TEMPLATES[name];
    if (!tpl)
        throw new Error(
            `Template '${name}' nicht gefunden. Verfügbar: ${Object.keys(TEMPLATES).join(', ')}`
        );
    return tpl(data);
}

export { TEMPLATES };
