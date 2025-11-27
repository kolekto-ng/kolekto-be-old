export const paymentInitializeTemplate = ({
  payerName,
  payerEmail,
  collectionTitle,
  amount,
  currency = 'NGN',
  authorizationUrl,
  transactionRef,
  participants = [],
  createdAt
}) => {
  const formatDate = (date) => {
    return new Date(date).toLocaleString('en-NG', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatCurrency = (value) => {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2
    }).format(value);
  };

  const participantDetails = participants
    .map((p) => {
      const details = p.details || [];
      return `
        <tr>
          <td colspan="2" style="padding: 15px; background-color: #f9fafb; border: 1px solid #e5e7eb;">
            <div style="margin: 0 0 10px 0;">
              <span style="font-weight: bold; color: #2d3748; font-size: 14px;">Contributor ${participants.length > 1 ? `(${participants.indexOf(p) + 1})` : ''}</span>
              ${p.uniqueCode ? `<span style="background-color: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; margin-left: 10px;">Code: ${p.uniqueCode}</span>` : ''}
            </div>
            <table style="width: 100%; font-size: 13px; color: #4a5568;">
              <tbody>
                ${details.map((detail) => `
                  <tr>
                    <td style="padding: 4px 0; font-weight: 600; color: #718096; width: 40%;">${detail.label}:</td>
                    <td style="padding: 4px 0; color: #2d3748;">${detail.value}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </td>
        </tr>
      `;
    })
    .join('');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Initialization - Kolekto</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: Arial, sans-serif;">
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #f4f4f4;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #28a745 0%, #20c997 100%); padding: 30px 20px; text-align: center; border-top-left-radius: 8px; border-top-right-radius: 8px;">
          <h1 style="color: #ffffff; font-size: 28px; margin: 0; font-weight: bold;">KOLEKTO</h1>
          <p style="color: rgba(255, 255, 255, 0.9); font-size: 14px; margin: 5px 0 0 0;">Payment Initialization</p>
        </div>

        <!-- Main Content -->
        <div style="background-color: #ffffff; padding: 30px; border-bottom-left-radius: 8px; border-bottom-right-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);">
          
          <!-- Greeting -->
          <h2 style="color: #2d3748; font-size: 24px; margin: 0 0 10px 0; text-align: center;">Payment Ready to Process</h2>
          <p style="color: #4a5568; font-size: 16px; line-height: 1.6; text-align: center; margin: 0 0 30px 0;">
            Hello <strong>${payerName}</strong>,<br>
            Your payment for <strong>${collectionTitle}</strong> is ready to be confirmed.
          </p>

          <!-- Payment Summary Card -->
          <div style="background-color: #f9fafb; border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 0 0 30px 0;">
            <table style="width: 100%; font-size: 14px; color: #4a5568;">
              <tbody>
                <tr style="border-bottom: 1px solid #e5e7eb;">
                  <td style="padding: 12px 0; font-weight: 600; width: 50%;">Collection:</td>
                  <td style="padding: 12px 0; text-align: right; color: #2d3748; font-weight: bold;">${collectionTitle}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e5e7eb;">
                  <td style="padding: 12px 0; font-weight: 600;">Amount:</td>
                  <td style="padding: 12px 0; text-align: right; color: #28a745; font-weight: bold; font-size: 18px;">${formatCurrency(amount)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e5e7eb;">
                  <td style="padding: 12px 0; font-weight: 600;">Currency:</td>
                  <td style="padding: 12px 0; text-align: right; color: #2d3748;">${currency}</td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; font-weight: 600;">Date:</td>
                  <td style="padding: 12px 0; text-align: right; color: #718096; font-size: 13px;">${formatDate(createdAt)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Transaction Reference -->
          ${transactionRef ? `
            <div style="background-color: #e7f3ff; border-left: 4px solid #0284c7; padding: 15px; margin: 0 0 30px 0; border-radius: 4px;">
              <p style="color: #0c4a6e; font-size: 12px; margin: 0 0 5px 0; font-weight: bold;">TRANSACTION REFERENCE</p>
              <p style="color: #075985; font-size: 14px; margin: 0; font-family: monospace; font-weight: bold; word-break: break-all;">${transactionRef}</p>
            </div>
          ` : ''}

          <!-- Contributor Details Section -->
          ${participants.length > 0 ? `
            <div style="margin: 0 0 30px 0;">
              <h3 style="color: #2d3748; font-size: 16px; margin: 0 0 15px 0; font-weight: bold;">Contributor Details</h3>
              <table style="width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden;">
                <tbody>
                  ${participantDetails}
                </tbody>
              </table>
            </div>
          ` : ''}

          <!-- Payer Information -->
          <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 0 0 30px 0; border-radius: 4px;">
            <p style="color: #92400e; font-size: 12px; margin: 0 0 8px 0; font-weight: bold;">PAYMENT FROM</p>
            <p style="color: #b45309; font-size: 14px; margin: 0 0 4px 0; font-weight: bold;">${payerName}</p>
            <p style="color: #92400e; font-size: 13px; margin: 0 0 2px 0;">${payerEmail}</p>
          </div>

          <!-- Call to Action Button -->
          <div style="text-align: center; margin: 30px 0;">
            <a href="${authorizationUrl}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: #ffffff; text-decoration: none; font-size: 16px; font-weight: bold; border-radius: 6px; box-shadow: 0 4px 6px rgba(40, 167, 69, 0.3); transition: all 0.3s ease;">
              Complete Payment
            </a>
          </div>

          <!-- Security Note -->
          <div style="background-color: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; padding: 15px; margin: 0 0 30px 0;">
            <p style="color: #166534; font-size: 13px; line-height: 1.6; margin: 0;">
              <strong>🔒 Security Note:</strong> You will be redirected to our secure payment gateway to complete this transaction. Your payment information is encrypted and secured.
            </p>
          </div>

          <!-- Instructions -->
          <div style="background-color: #f3f4f6; padding: 20px; border-radius: 6px; margin: 0 0 30px 0;">
            <h4 style="color: #2d3748; font-size: 14px; margin: 0 0 12px 0; font-weight: bold;">What happens next?</h4>
            <ol style="color: #4a5568; font-size: 13px; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Click the "Complete Payment" button above</li>
              <li>You'll be taken to our secure payment gateway</li>
              <li>Follow the payment instructions</li>
              <li>You'll receive a confirmation email once payment is successful</li>
            </ol>
          </div>

          <!-- Footer divider -->
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">

          <!-- Support Info -->
          <p style="color: #4a5568; font-size: 13px; line-height: 1.6; text-align: center; margin: 0 0 15px 0;">
            Need help? Contact our support team at <a href="mailto:team@kolekto.com.ng" style="color: #28a745; text-decoration: none; font-weight: bold;">team@kolekto.com.ng</a>
          </p>

          <!-- Footer -->
          <p style="color: #718096; font-size: 12px; text-align: center; margin: 0;">
            © 2025 Kolekto. All rights reserved. | <a href="https://kolekto.com.ng" style="color: #28a745; text-decoration: none;">Visit our website</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
};