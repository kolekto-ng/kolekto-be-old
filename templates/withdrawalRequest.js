export const withdrawalRequestTemplate = ({
  userName,
  amount,
  currency = "NGN",
  withdrawalId,
  status = "received",
  expectedProcessingDays = 1,
  accountName,
  accountNumber,
  bankName,
  submittedAt = new Date().toISOString(),
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

  const statusLabel = status === "approved" ? "Approved" : status === "processing" ? "Processing" : "Received";

  const detailsRows = `
    <tr>
      <td style="padding:8px 0; color:#6b7280; font-weight:600; width:45%;">Withdrawal ID</td>
      <td style="padding:8px 0; color:#111827; font-weight:700;">${withdrawalId || "N/A"}</td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#6b7280; font-weight:600;">Amount</td>
      <td style="padding:8px 0; color:#111827; font-weight:700;">${formatCurrency(amount)}</td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#6b7280; font-weight:600;">Destination</td>
      <td style="padding:8px 0; color:#111827; font-weight:600;">${accountName || "N/A"} — ${bankName || "N/A"}</td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#6b7280; font-weight:600;">Account Number</td>
      <td style="padding:8px 0; color:#111827; font-weight:600;">${accountNumber || "N/A"}</td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#6b7280; font-weight:600;">Submitted</td>
      <td style="padding:8px 0; color:#111827;">${formatDate(submittedAt)}</td>
    </tr>
    <tr>
      <td style="padding:8px 0; color:#6b7280; font-weight:600;">Status</td>
      <td style="padding:8px 0; color:#111827;"><strong>${statusLabel}</strong></td>
    </tr>
  `;

  return `
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Withdrawal Request Received - Kolekto</title>
  </head>
  <body style="margin:0;background:#f5f7fb;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;">
    <div style="max-width:640px;margin:28px auto;padding:0;">
      <div style="background:linear-gradient(90deg,#10b981,#06b6d4);padding:22px;border-radius:8px 8px 0 0;color:#fff;text-align:center;">
        <h1 style="margin:0;font-size:20px;">Withdrawal Request Received</h1>
        <p style="margin:6px 0 0 0;font-size:13px;opacity:0.95;">Kolekto payout service</p>
      </div>

      <div style="background:#ffffff;padding:24px;border:1px solid #e6eef7;border-top:none;border-radius:0 0 8px 8px;">
        <p style="margin:0 0 14px 0;color:#374151;font-size:15px;">Hi <strong>${userName}</strong>,</p>

        <p style="margin:0 0 18px 0;color:#4b5563;font-size:14px;line-height:1.5;">
          We’ve received your withdrawal request and it is now being processed. Below are the details of your request.
        </p>

        <table style="width:100%;border-collapse:collapse;margin:10px 0 18px 0;font-size:14px;">
          <tbody>
            ${detailsRows}
          </tbody>
        </table>

        <p style="margin:0 0 16px 0;color:#4b5563;font-size:13px;">
          Estimated processing time: <strong>${expectedProcessingDays} business day${expectedProcessingDays > 1 ? "s" : ""}</strong>. We will notify you if any additional verification is required.
        </p>

        <div style="text-align:center;margin:18px 0;">
          <a href="${dashboardUrl}/wallet/withdrawals" style="display:inline-block;padding:10px 18px;background:#0ea5a4;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
            View withdrawal status
          </a>
        </div>

        <p style="margin:0 0 10px 0;color:#6b7280;font-size:12px;">
          If you need to contact us about this request, reply to this email or reach out to <a href="mailto:${supportEmail}" style="color:#0ea5a4;text-decoration:none;">${supportEmail}</a>.
        </p>

        <hr style="border:none;border-top:1px solid #eef2f7;margin:18px 0;" />

        <p style="margin:0;color:#9ca3af;font-size:12px;text-align:center;">
          Kolekto • © ${new Date().getFullYear()} Kolekto Limited. All rights reserved.
        </p>
      </div>
    </div>
  </body>
  </html>
  `;
};