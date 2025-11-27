export const withdrawalApprovedTemplate = ({
  userName,
  amount,
  currency = "NGN",
  withdrawalId,
  processedAt = new Date().toISOString(),
  status = "Processed",
  accountName,
  accountNumber,
  bankName,
  reference, // document number / transfer reference
  currentBalance,
  availableBalance,
  dashboardUrl = process.env.FRONTEND_URL || "https://www.kolekto.com.ng",
  supportEmail = "team@kolekto.com.ng"
}) => {
  const formatDate = (d) =>
    new Date(d).toLocaleString("en-NG", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });

  const formatCurr = (v) =>
    new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(v || 0);

  const maskAccount = (num) => {
    if (!num) return "N/A";
    const s = String(num);
    if (s.length <= 4) return "****" + s;
    return "******" + s.slice(-4);
  };

  const receiptUrl = `${dashboardUrl}/wallet/withdrawals/${withdrawalId}`;

  return `
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Withdrawal Processed - Kolekto</title>
  </head>
  <body style="margin:0;font-family:Segoe UI,Roboto,Arial,sans-serif;background:#f6f7fb;color:#1f2937;">
    <div style="max-width:700px;margin:18px auto;">
      <div style="background:#0b6f66;color:#fff;padding:18px 20px;border-radius:6px 6px 0 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong style="font-size:16px;">Kolekto Transaction Notification</strong>
            <div style="font-size:12px;opacity:0.95;margin-top:4px;">Automated Payout Notice</div>
          </div>
          <div style="text-align:right;font-size:12px;opacity:0.95;">
            ${formatDate(processedAt)}
          </div>
        </div>
      </div>

      <div style="background:#fff;padding:22px;border:1px solid #e6eef7;border-top:none;border-radius:0 0 6px 6px;">
        <p style="margin:0 0 12px 0;font-size:14px;">
          Dear <strong>${userName}</strong>,
        </p>

        <p style="margin:0 0 16px 0;font-size:13px;color:#374151;line-height:1.5;">
          We wish to inform you that a DEBIT transaction for your withdrawal request has been ${status.toLowerCase()}. The details are shown below.
        </p>

        <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151;margin-bottom:14px;">
          <tbody>
            <tr style="border-bottom:1px solid #eef2f7;">
              <td style="padding:10px 0;color:#6b7280;font-weight:600;width:45%;">Account</td>
              <td style="padding:10px 0;font-weight:700;text-align:right;">${maskAccount(accountNumber)} — ${bankName || ""}</td>
            </tr>
            <tr style="border-bottom:1px solid #eef2f7;">
              <td style="padding:10px 0;color:#6b7280;font-weight:600;">Description</td>
              <td style="padding:10px 0;text-align:right;">Kolekto payout to ${accountName || "recipient"}</td>
            </tr>
            <tr style="border-bottom:1px solid #eef2f7;">
              <td style="padding:10px 0;color:#6b7280;font-weight:600;">Amount</td>
              <td style="padding:10px 0;font-weight:800;text-align:right;color:#0b6f66;">${formatCurr(amount)}</td>
            </tr>
            <tr style="border-bottom:1px solid #eef2f7;">
              <td style="padding:10px 0;color:#6b7280;font-weight:600;">Value Date</td>
              <td style="padding:10px 0;text-align:right;">${new Date(processedAt).toLocaleDateString('en-NG')}</td>
            </tr>
            <tr style="border-bottom:1px solid #eef2f7;">
              <td style="padding:10px 0;color:#6b7280;font-weight:600;">Time of Transaction</td>
              <td style="padding:10px 0;text-align:right;">${new Date(processedAt).toLocaleTimeString('en-NG')}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;color:#6b7280;font-weight:600;">Document Number</td>
              <td style="padding:10px 0;font-family:monospace;font-weight:700;text-align:right;">${reference || withdrawalId}</td>
            </tr>
          </tbody>
        </table>

        <div style="background:#f8fafc;border-left:4px solid #c7f0ea;padding:14px;border-radius:4px;margin-bottom:16px;">
          <p style="margin:0;font-size:13px;color:#065f54;">
            <strong>Balances as at ${new Date(processedAt).toLocaleTimeString('en-NG')}:</strong>
          </p>
          <p style="margin:8px 0 0 0;font-size:13px;color:#374151;">
            Current Balance: <strong>${formatCurr(currentBalance)}</strong><br/>
            Available Balance: <strong>${formatCurr(availableBalance)}</strong>
          </p>
        </div>

        <div style="text-align:center;margin:18px 0;">
          <a href="${receiptUrl}" style="display:inline-block;padding:10px 18px;background:#0b6f66;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">View transaction / download receipt</a>
        </div>

        <p style="margin:0 0 12px 0;font-size:13px;color:#4b5563;line-height:1.5;">
          If you did not request this withdrawal or you notice any discrepancy, please contact our support immediately at <a href="mailto:${supportEmail}" style="color:#0b6f66;text-decoration:none;">${supportEmail}</a>.
        </p>

        <hr style="border:none;border-top:1px solid #eef2f7;margin:18px 0;" />

        <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
          Thank you for using Kolekto.<br/>
          © ${new Date().getFullYear()} Kolekto Limited. All rights reserved.
        </p>
      </div>
    </div>
  </body>
  </html>
  `;
};