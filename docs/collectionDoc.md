# Create Collection Function Documentation

## Overview

The `createCollection` controller handles the creation of a new collection in the app. It:

- Validates required fields from the request.
- Uses the authenticated user's ID as the `user_id`.
- Calculates all relevant financial breakdowns and fields.
- Inserts the new collection into the Supabase `collections` table.
- Returns the created collection or an error.

---

## Request Structure

**POST** `/api/create-collection`

**Body:**

```json
{
  "collectionData": {
    "title": "My Collection",
    "description": "Description here",
    "amount": 10000,
    "deadline": "2024-12-31T23:59:59Z",
    "max_participants": 100,
    "form_fields": [],
    "pricing_tiers": [],
    "status": "active",
    "fee_bearer": "organizer", // or "contributor"
    "currency": "NGN",
    "currency_symbol": "₦"
  }
}


Note: user_id is set automatically from the authenticated user.

Financial Data Calculations
1. Platform Fee (platformFee)
Calculated as a percentage of the collection amount.
Tiers:
< 1000: 3%
< 5000: 2.5%
< 20000: 2%
>= 20000: 1.5%
Formula:
platformFee = amount * kolektoFeePercentage
2. Payment Gateway Fee (paymentGatewayFee)
1.5% of the amount, capped at 2000.
Formula:
paymentGatewayFee = min(amount * 0.015, 2000)
3. Total Fees (totalFees)
Sum of platform and gateway fees.
Formula:
totalFees = platformFee + paymentGatewayFee
4. Total Payable (totalPayable)
If fee_bearer is "contributor", contributor pays the fees on top of the amount.
If fee_bearer is "organizer", organizer receives the amount minus fees.
Formula:
Contributor: totalPayable = amount + totalFees
Organizer: totalPayable = amount
5. Gross Payment (gross_payment)
The original amount set for the collection.
Formula:
gross_payment = amount
6. Net Payment (net_payment)
The amount the organizer will actually receive after all fees.
Formula:
If fee_bearer is "contributor": net_payment = amount
If fee_bearer is "organizer": net_payment = amount - totalFees
7. Balance (balance)
The current available amount for withdrawal.
Formula:
balance = net_payment - withdrawn
On creation, withdrawn = 0, so balance = net_payment.
8. Withdrawn (withdrawn)
The total amount already withdrawn by the organizer.
Initial value: 0
Updated: Each time a withdrawal is made, increase by the withdrawn amount.
9. Total Fees (total_fees)
Same as totalFees above, stored for reference.
10. Total Contributions (total_contributions)
Number of contributions made to the collection.
Initial value: 0
Updated: Incremented as contributors make payments.
Usage of Financial Fields Throughout the App
On Creation:
All financial fields are calculated and stored as described above.

On Contribution:

gross_payment, net_payment, balance, and total_contributions should be updated as new contributions are made.
If contributors pay the fees, net_payment increases by the full contribution amount.
If organizer pays the fees, net_payment increases by (contribution - fees).
On Withdrawal:

When the organizer withdraws funds, increase withdrawn and decrease balance accordingly.
For Reporting:

Use gross_payment for total raised.
Use net_payment for total available to the organizer.
Use balance for current withdrawable amount.
Use total_fees for total fees collected by the platform and gateway.
Example Calculation
For a collection with: <vscode_annotation details='%5B%7B%22title%22%3A%22hardcoded-credentials%22%2C%22description%22%3A%22Embedding%20credentials%20in%20source%20code%20risks%20unauthorized%20access%22%7D%5D'>-</vscode_annotation> amount = 10,000

fee_bearer = "organizer"
Calculation:

platformFee = 10,000 * 0.02 = 200
paymentGatewayFee = 10,000 * 0.015 = 150
totalFees = 200 + 150 = 350
totalPayable = 10,000
gross_payment = 10,000
net_payment = 10,000 - 350 = 9,650
balance = 9,650
withdrawn = 0
Notes
Always ensure the backend updates these fields on every relevant action (contribution, withdrawal).
All calculations should be consistent to avoid discrepancies in reporting and payouts.
Adjust fee percentages and caps as your business rules evolve.
```
