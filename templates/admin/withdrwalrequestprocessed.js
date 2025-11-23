export const adminWithdrawalProcessedTemplate = ({
    adminName = "Admin",
    userName,
    userEmail,
    userId,
    amount,
    currency = "NGN",
    withdrawalId,
    processedAt = new Date().toISOString(),
    accountName,
    accountNumber,
    bankName,
    reference,
    walletLink = `${process.env.FRONTEND_URL || "https://www.kolekto.com.ng"}/admin/withdrawals/${withdrawalId}`,
    note = ""
}) => {
    const fmtDate = (d) => new Date(d).toLocaleString("en-NG", {
        day: "numeric", month: "long", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    const fmtCurr = (v) => new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(v || 0);
    const mask = (n) => n ? `******${String(n).slice(-4)}` : "N/A";

    return `
  <!doctype html>
  <html lang="en">
  <head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
  <body style="font-family:Segoe UI,Roboto,Arial,sans-serif;background:#f6f7fb;margin:0;padding:20px;color:#111;">
    <div style="max-width:720px;margin:0 auto;">
      <div style="background:#0b6f66;color:#fff;padding:12px 16px;border-radius:6px;">
        <strong>Withdrawal Processed — Action Completed</strong>
        <div style="font-size:12px;opacity:0.9;">${fmtDate(processedAt)}</div>
      </div>

      <div style="background:#fff;border:1px solid #e6eef7;padding:18px;border-radius:0 0 6px 6px;">
        <p style="margin:0 0 10px 0;">Hi <strong>${adminName}</strong>,</p>

        <p style="margin:0 0 12px 0;color:#374151;font-size:14px;">
          The following withdrawal has been processed. Use the link below to review the record in the admin panel.
        </p>

        <table style="width:100%;border-collapse:collapse;font-size:14px;margin:10px 0 14px 0;">
          <tbody>
            <tr><td style="color:#6b7280;padding:8px;width:38%;">Withdrawal ID</td><td style="padding:8px;font-weight:700;">${withdrawalId}</td></tr>
            <tr><td style="color:#6b7280;padding:8px;">Requester</td><td style="padding:8px;">${userName} (${userEmail || "N/A"}) — ID: ${userId.slice(1, 4) || "N/A"}</td></tr>
            <tr><td style="color:#6b7280;padding:8px;">Amount</td><td style="padding:8px;font-weight:700;">${fmtCurr(amount)}</td></tr>
            <tr><td style="color:#6b7280;padding:8px;">Destination</td><td style="padding:8px;">${accountName || "N/A"} — ${bankName || "N/A"}</td></tr>
            <tr><td style="color:#6b7280;padding:8px;">Account Number</td><td style="padding:8px;">${mask(accountNumber)}</td></tr>
            <tr><td style="color:#6b7280;padding:8px;">Document / Ref</td><td style="padding:8px;font-family:monospace;font-weight:700;">${reference || withdrawalId}</td></tr>
            <tr><td style="color:#6b7280;padding:8px;">Processed At</td><td style="padding:8px;">${fmtDate(processedAt)}</td></tr>
          </tbody>
        </table>

        ${note ? `<div style="background:#fff4e6;border-left:4px solid #ffb020;padding:10px;border-radius:4px;margin-bottom:12px;"><strong>Note:</strong> ${note}</div>` : ""}

        <div style="text-align:center;margin:14px 0;">
          <a href="${walletLink}" style="display:inline-block;padding:10px 16px;background:#0b6f66;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">Open withdrawal in admin</a>
        </div>

        <p style="font-size:12px;color:#6b7280;margin:12px 0 0 0;">This is an automated notification. No reply required.</p>
      </div>
    </div>
  </body>
  </html>
  `;
};