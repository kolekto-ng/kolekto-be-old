export const paymentConfirmationTemplate = ({
    payerName,
    payerEmail,
    collectionTitle,
    amount,
    currency = 'NGN',
    transactionRef,
    status = 'success',
    paidAt,
    channel = 'card',
    participants = [],
    receiptUrl,
    organizerName = 'Collection Organizer'
}) => {
    const formatDate = (date) => {
        return new Date(date).toLocaleString('en-NG', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    };

    const formatTime = (date) => {
        return new Date(date).toLocaleTimeString('en-NG', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    };

    const formatCurrency = (value) => {
        return new Intl.NumberFormat('en-NG', {
            style: 'currency',
            currency: currency,
            minimumFractionDigits: 2
        }).format(value);
    };

    // Generate receipt URL from transaction reference
    const dynamicReceiptUrl = `${process.env.FRONTEND_URL || 'https://www.kolekto.com.ng'}/payment/verify?trxref=${transactionRef}&reference=${transactionRef}`;
    const finalReceiptUrl = dynamicReceiptUrl;

    const participantDetails = participants
        .map((p) => {
            const details = p.details || [];
            return `
        <tr>
          <td colspan="2" style="padding: 15px; background-color: #f9fafb; border: 1px solid #e5e7eb;">
            <div style="margin: 0 0 12px 0;">
              <span style="font-weight: bold; color: #2d3748; font-size: 14px;">Contributor ${participants.length > 1 ? `(${participants.indexOf(p) + 1})` : ''}</span>
              ${p.uniqueCode ? `<span style="background-color: #e0f2fe; color: #0369a1; padding: 3px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; margin-left: 8px; display: inline-block;">Code: ${p.uniqueCode}</span>` : ''}
            </div>
            <table style="width: 100%; font-size: 13px; color: #4a5568;">
              <tbody>
                ${details.map((detail) => `
                  <tr>
                    <td style="padding: 5px 0; font-weight: 600; color: #718096; width: 35%;">${detail.label}:</td>
                    <td style="padding: 5px 0; color: #2d3748; word-break: break-word;">${detail.value}</td>
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
      <title>Payment Confirmation - Kolekto</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: 0 auto; padding: 0; background-color: #f5f5f5;">
        
        <!-- Header with Status -->
        <div style="background: linear-gradient(135deg, #28a745 0%, #20c997 100%); padding: 25px 20px; text-align: center; position: relative; overflow: hidden;">
          <div style="position: absolute; top: 0; right: 0; width: 100px; height: 100px; background: rgba(255,255,255,0.1); border-radius: 50%; margin: -50px -50px 0 0;"></div>
          <h1 style="color: #ffffff; font-size: 26px; margin: 0 0 5px 0; font-weight: bold; position: relative; z-index: 1;">✓ PAYMENT SUCCESSFUL</h1>
          <p style="color: rgba(255, 255, 255, 0.95); font-size: 13px; margin: 0; position: relative; z-index: 1; letter-spacing: 0.5px;">Kolekto Payment Notification Service (KPN)</p>
        </div>

        <!-- Main Content -->
        <div style="background-color: #ffffff; padding: 35px 25px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);">
          
          <!-- Greeting -->
          <p style="color: #2d3748; font-size: 15px; line-height: 1.6; margin: 0 0 25px 0;">
            Dear <strong>${payerName}</strong>,
          </p>

          <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 30px 0;">
            We are pleased to inform you that your payment to <strong>${collectionTitle}</strong> has been successfully processed and confirmed. Please find the transaction details below.
          </p>

           <!-- Receipt Section -->
          <div style="background-color: #e7f3ff; border: 1px solid #b3e5fc; border-radius: 6px; padding: 20px; margin: 0 0 30px 0; text-align: center;">
            <p style="color: #01579b; font-size: 14px; margin: 0 0 15px 0;">
              <strong>📄 Your Receipt is Ready</strong>
            </p>
            <p style="color: #0277bd; font-size: 13px; line-height: 1.6; margin: 0 0 15px 0;">
              A detailed receipt with all transaction information has been generated and can be accessed from your account dashboard or via the link below.
            </p>
            <a href="${finalReceiptUrl}" style="display: inline-block; padding: 10px 24px; background-color: #0277bd; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: bold; border-radius: 4px; margin: 0 5px;">
              View Receipt
            </a>
          </div>

          <!-- Transaction Details - Bank Style -->
          <div style="background-color: #f8f9fa; border-left: 4px solid #28a745; padding: 20px; margin: 0 0 30px 0; border-radius: 4px;">
            <p style="color: #6c757d; font-size: 12px; margin: 0 0 15px 0; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">Transaction Notification</p>
            
            <table style="width: 100%; font-size: 14px; color: #2d3748; border-collapse: collapse;">
              <tbody>
                <tr style="border-bottom: 1px solid #e9ecef;">
                  <td style="padding: 10px 0; font-weight: 600; width: 50%; color: #6c757d;">Collection</td>
                  <td style="padding: 10px 0; text-align: right; font-weight: 500;">${collectionTitle}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e9ecef;">
                  <td style="padding: 10px 0; font-weight: 600; color: #6c757d;">Amount</td>
                  <td style="padding: 10px 0; text-align: right; color: #28a745; font-weight: bold; font-size: 18px;">${formatCurrency(amount)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e9ecef;">
                  <td style="padding: 10px 0; font-weight: 600; color: #6c757d;">Value Date</td>
                  <td style="padding: 10px 0; text-align: right;">${paidAt ? new Date(paidAt).toLocaleDateString('en-NG') : 'N/A'}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e9ecef;">
                  <td style="padding: 10px 0; font-weight: 600; color: #6c757d;">Time of Transaction</td>
                  <td style="padding: 10px 0; text-align: right; font-weight: 500;">${paidAt ? formatTime(paidAt) : 'N/A'}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e9ecef;">
                  <td style="padding: 10px 0; font-weight: 600; color: #6c757d;">Channel</td>
                  <td style="padding: 10px 0; text-align: right; text-transform: capitalize;">${channel}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e9ecef;">
                  <td style="padding: 10px 0; font-weight: 600; color: #6c757d;">Status</td>
                  <td style="padding: 10px 0; text-align: right;"><span style="background-color: #d4edda; color: #155724; padding: 3px 8px; border-radius: 3px; font-size: 12px; font-weight: bold;">${status.toUpperCase()}</span></td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; font-weight: 600; color: #6c757d;">Document Number</td>
                  <td style="padding: 10px 0; text-align: right; font-family: monospace; font-weight: bold; font-size: 12px;">${transactionRef}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Contributor Details -->
          ${participants.length > 0 ? `
            <div style="margin: 0 0 30px 0;">
              <h3 style="color: #2d3748; font-size: 15px; margin: 0 0 15px 0; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">Contributor Information</h3>
              <table style="width: 100%; border-collapse: collapse; border: 1px solid #e9ecef; border-radius: 4px; overflow: hidden;">
                <tbody>
                  ${participantDetails}
                </tbody>
              </table>
            </div>
          ` : ''}

          <!-- Payment From -->
          <div style="background-color: #fef9e7; border-left: 4px solid #ffc107; padding: 15px; margin: 0 0 30px 0; border-radius: 4px;">
            <p style="color: #856404; font-size: 12px; margin: 0 0 8px 0; font-weight: bold; text-transform: uppercase;">Payment From</p>
            <p style="color: #2d3748; font-size: 14px; margin: 0 0 4px 0; font-weight: bold;">${payerName}</p>
            <p style="color: #6c757d; font-size: 13px; margin: 0;">${payerEmail}</p>
          </div>

         

          <!-- Important Notes -->
          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 0 0 30px 0;">
            <h4 style="color: #2d3748; font-size: 13px; margin: 0 0 10px 0; font-weight: bold; text-transform: uppercase;">Important Notes</h4>
            <ul style="color: #4a5568; font-size: 12px; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Please keep this email for your records</li>
              <li>Your payment confirmation has been sent to the collection organizer</li>
              <li>Transaction reference: <strong>${transactionRef}</strong></li>
              <li>For inquiries, contact us at <a href="mailto:support@kolekto.com.ng" style="color: #28a745; text-decoration: none;">support@kolekto.com.ng</a></li>
            </ul>
          </div>

          <!-- Footer divider -->
          <hr style="border: none; border-top: 1px solid #e9ecef; margin: 25px 0;">

          <!-- Security & Privacy -->
          <p style="color: #6c757d; font-size: 12px; line-height: 1.6; text-align: center; margin: 0 0 15px 0;">
            <strong>🔒 Security:</strong> The privacy and security of your account details is important to us. Never share this email or your transaction reference with anyone.
          </p>

          <!-- Footer -->
          <p style="color: #6c757d; font-size: 12px; text-align: center; margin: 0;">
            © 2025 Kolekto Limited. All rights reserved.<br>
            <a href="https://kolekto.com.ng" style="color: #28a745; text-decoration: none;">Visit our website</a> | 
            <a href="mailto:support@kolekto.com.ng" style="color: #28a745; text-decoration: none;">Contact Support</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
};