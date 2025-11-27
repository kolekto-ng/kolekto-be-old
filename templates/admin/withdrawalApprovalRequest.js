export const withdrawalApprovalRequestTemplate = ({
  adminName = "Admin",
  userName,
  amount,
  currency = "NGN",
  withdrawalId,
  accountName,
  accountNumber,
  bankName,
  submittedAt = new Date().toISOString(),
  approveUrl,
  declineUrl,
  dashboardUrl = process.env.FRONTEND_URL || "https://www.kolekto.com.ng",
  supportEmail = "team@kolekto.com.ng"
}) => {
  const formatDate = (d) =>
    new Date(d).toLocaleString("en-NG", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

  const formatCurrency = (v) =>
    new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(v);

  return `
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Withdrawal Approval Required - Kolekto</title>
  </head>
  <body style="margin:0;background:#f4f6f8;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;">
    <div style="max-width:640px;margin:28px auto;padding:0;">
      <div style="background:#0ea5a4;padding:18px;border-radius:8px 8px 0 0;color:#fff;text-align:left;">
        <h2 style="margin:0;font-size:18px;">Withdrawal Approval Required</h2>
        <p style="margin:6px 0 0 0;font-size:13px;opacity:0.95;">Action required: review and approve/decline</p>
      </div>

      <div style="background:#fff;padding:20px;border:1px solid #e6eef7;border-top:none;border-radius:0 0 8px 8px;">
        <p style="margin:0 0 12px 0;color:#374151;font-size:14px;">Hi <strong>${adminName}</strong>,</p>

        <p style="margin:0 0 12px 0;color:#374151;font-size:14px;">
          A withdrawal request requires your approval. Details:
        </p>

        <table style="width:100%;border-collapse:collapse;margin:10px 0 16px 0;font-size:14px;">
          <tbody>
            <tr>
              <td style="padding:8px 0;color:#6b7280;font-weight:600;width:40%;">Withdrawal ID</td>
              <td style="padding:8px 0;color:#111827;font-weight:700;">${withdrawalId || "N/A"}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#6b7280;font-weight:600;">Requester</td>
              <td style="padding:8px 0;color:#111827;">${userName}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#6b7280;font-weight:600;">Amount</td>
              <td style="padding:8px 0;color:#111827;font-weight:700;">${formatCurrency(amount)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#6b7280;font-weight:600;">Destination</td>
              <td style="padding:8px 0;color:#111827;">${accountName || "N/A"} — ${bankName || "N/A"}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#6b7280;font-weight:600;">Account Number</td>
              <td style="padding:8px 0;color:#111827;">${accountNumber || "N/A"}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#6b7280;font-weight:600;">Submitted</td>
              <td style="padding:8px 0;color:#111827;">${formatDate(submittedAt)}</td>
            </tr>
          </tbody>
        </table>

        <div style="text-align:center;margin:18px 0;">
          ${approveUrl ? `<a href="${approveUrl}" style="display:inline-block;padding:10px 16px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;margin-right:8px;">Approve</a>` : ''}
          ${declineUrl ? `<a href="${declineUrl}" style="display:inline-block;padding:10px 16px;background:#ef4444;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">Decline</a>` : ''}
        </div>

        <p style="margin:0 0 10px 0;color:#6b7280;font-size:13px;">
          Or review the request in the admin dashboard:
          <a href="${dashboardUrl}/admin/withdrawals" style="color:#0ea5a4;text-decoration:none;">Open withdrawals</a>
        </p>

        <hr style="border:none;border-top:1px solid #eef2f7;margin:18px 0;" />

        <p style="margin:0;color:#9ca3af;font-size:12px;text-align:left;">
          If you did not expect this request, contact support: <a href="mailto:${supportEmail}" style="color:#0ea5a4;text-decoration:none;">${supportEmail}</a>
        </p>
      </div>
    </div>
  </body>
  </html>
  `;
};