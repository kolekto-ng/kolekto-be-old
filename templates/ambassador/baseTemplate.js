// Shared brand wrapper for every Ambassador Program email.
// Keeps one consistent visual system (colors, header, footer) across all
// ambassador lifecycle emails instead of each template hand-rolling markup.

const BRAND_PRIMARY = '#1B5E20'; // deep green — matches kolekto-fe-old (consumer-facing site)
const BRAND_PRIMARY_DARK = '#123D15';
const BRAND_YELLOW = '#FFCA28';
const BRAND_ORANGE = '#FFA726';
const TEXT_DARK = '#1f2937';
const TEXT_MUTED = '#6b7280';

const SITE_URL = process.env.FRONTEND_URL || 'https://www.kolekto.com.ng';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'team@kolekto.com.ng';

/**
 * Wraps template-specific body markup in the shared Kolekto Ambassador
 * header/footer shell. `bodyHtml` should be a series of block elements
 * (headings, paragraphs, tables) — no need to include <html>/<body> tags.
 */
export function renderAmbassadorEmail({
  title,
  preheader = '',
  bodyHtml,
  ctaLabel,
  ctaUrl,
}) {
  const cta = ctaLabel && ctaUrl
    ? `
      <div style="text-align:center;margin:28px 0 8px 0;">
        <a href="${ctaUrl}" style="display:inline-block;background:${BRAND_ORANGE};color:#1a1a1a;font-weight:700;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none;">
          ${ctaLabel}
        </a>
      </div>
    `
    : '';

  return `
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${title || 'Kolekto Ambassador Program'}</title>
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
                <div style="margin-top:4px;font-size:12px;font-weight:600;color:${BRAND_YELLOW};text-transform:uppercase;letter-spacing:1px;">
                  Ambassador Program
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 28px 8px 28px;color:${TEXT_DARK};font-size:15px;line-height:1.65;">
                ${bodyHtml}
                ${cta}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 32px 28px;">
                <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 20px 0;" />
                <p style="margin:0 0 6px 0;font-size:13px;color:${TEXT_MUTED};">
                  Need help? Reach us at
                  <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND_PRIMARY};text-decoration:none;font-weight:600;">${SUPPORT_EMAIL}</a>
                </p>
                <p style="margin:0 0 14px 0;font-size:13px;color:${TEXT_MUTED};">
                  <a href="${SITE_URL}" style="color:${BRAND_PRIMARY};text-decoration:none;">${SITE_URL.replace(/^https?:\/\//, '')}</a>
                  &nbsp;•&nbsp;
                  <a href="https://twitter.com/kolektong" style="color:${TEXT_MUTED};text-decoration:none;">Twitter</a>
                  &nbsp;•&nbsp;
                  <a href="https://instagram.com/kolekto.ng" style="color:${TEXT_MUTED};text-decoration:none;">Instagram</a>
                </p>
                <p style="margin:0;font-size:11px;color:#9ca3af;">
                  © ${new Date().getFullYear()} Kolekto Limited. All rights reserved. You're receiving this email because you're part of the Kolekto Ambassador Program.
                </p>
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

export const AMBASSADOR_BRAND = {
  primary: BRAND_PRIMARY,
  primaryDark: BRAND_PRIMARY_DARK,
  yellow: BRAND_YELLOW,
  orange: BRAND_ORANGE,
  textDark: TEXT_DARK,
  textMuted: TEXT_MUTED,
  siteUrl: SITE_URL,
  supportEmail: SUPPORT_EMAIL,
};
