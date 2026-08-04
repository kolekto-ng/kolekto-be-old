// Shared brand wrapper for every Email Campaign sent from the Communications
// system. Mirrors templates/ambassador/baseTemplate.js's structure (own
// palette, own header/footer), but the body comes from an admin-authored
// campaign (rich-text editor output in Phase 2+, raw HTML in Phase 1)
// instead of a fixed lifecycle-event template.
import juice from 'juice';

const BRAND_PRIMARY = '#1B5E20';
const BRAND_PRIMARY_DARK = '#123D15';
const BRAND_YELLOW = '#FFCA28';
const BRAND_ORANGE = '#FFA726';
const TEXT_DARK = '#1f2937';
const TEXT_MUTED = '#6b7280';

const SITE_URL = process.env.FRONTEND_URL || 'https://www.kolekto.com.ng';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'team@kolekto.com.ng';

export const KOLEKTO_MARKETING_BRAND = {
  primary: BRAND_PRIMARY,
  primaryDark: BRAND_PRIMARY_DARK,
  yellow: BRAND_YELLOW,
  orange: BRAND_ORANGE,
  textDark: TEXT_DARK,
  textMuted: TEXT_MUTED,
  siteUrl: SITE_URL,
  supportEmail: SUPPORT_EMAIL,
};

const DEFAULT_FOOTER = `
  <p style="margin:0 0 6px 0;font-size:13px;color:${TEXT_MUTED};">
    Need help? Reach us at
    <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND_PRIMARY};text-decoration:none;font-weight:600;">${SUPPORT_EMAIL}</a>
  </p>
  <p style="margin:0;font-size:11px;color:#9ca3af;">
    © ${new Date().getFullYear()} Kolekto Limited. All rights reserved.
  </p>
`;

/**
 * Wraps a campaign's body HTML in the shared Kolekto Marketing header/footer
 * shell. `bodyHtml` is the admin-authored content (block elements only — no
 * <html>/<body> needed). Returns raw HTML; call inlineCampaignHtml() on the
 * result before sending so styles survive Gmail/Outlook stripping <style>
 * blocks.
 */
export function renderCampaignEmail({ subject, preheader = '', bodyHtml, footerHtml }) {
  return `
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${subject || 'Kolekto'}</title>
  </head>
  <body style="margin:0;padding:0;background:#f2f4f3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <span style="display:none;font-size:1px;color:#f2f4f3;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      ${preheader}
    </span>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f3;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
            <tr>
              <td style="background:linear-gradient(135deg,${BRAND_PRIMARY},${BRAND_PRIMARY_DARK});padding:28px 24px;text-align:center;">
                <span style="font-size:26px;font-weight:800;color:#ffffff;letter-spacing:0.5px;">Kolekto</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 28px 8px 28px;color:${TEXT_DARK};font-size:15px;line-height:1.65;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 32px 28px;">
                <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 20px 0;" />
                ${footerHtml || DEFAULT_FOOTER}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

/**
 * Inlines all CSS into style= attributes so the email renders correctly in
 * clients (Gmail, Outlook) that strip <style> blocks or ignore embedded
 * stylesheets.
 */
export function inlineCampaignHtml(html) {
  return juice(html);
}
