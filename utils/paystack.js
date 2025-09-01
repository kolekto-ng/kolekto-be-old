import axios from "axios";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

// Axios instance for Paystack
const paystackApi = axios.create({
    baseURL: "https://api.paystack.co",
    headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
    },
});

// Get list of banks
export async function getBanks() {
    try {
        const res = await paystackApi.get("/bank", {
            params: { currency: "NGN" },
        });

        if (!res.data.status) {
            throw new Error(res.data.message || "Failed to fetch banks");
        }
        return res.data.data; // array of { name, code }
    } catch (err) {
        console.error("Paystack getBanks error:", err.response?.data || err.message);
        throw err;
    }
}

// Verify account number
export async function verifyAccount(account_number, bank_code) {
    try {
        const res = await paystackApi.get("/bank/resolve", {
            params: { account_number, bank_code },
        });

        if (!res.data.status) {
            throw new Error(res.data.message || "Failed to verify account");
        }
        return res.data.data; // { account_name, account_number, bank_id }
    } catch (err) {
        console.error("Paystack verifyAccount error:", err.response?.data || err.message);
        throw err;
    }
}


/**
 * Create a payout recipient on Paystack
 * @param {string} account_number - Bank account number
 * @param {string} bank_code - Paystack bank code
 * @param {string} account_name - Verified account name
 * @returns {Promise<{ recipient_code: string }>}
 */
export async function createRecipient(account_number, bank_code, account_name) {
    try {
        const response = await axios.post(
            "https://api.paystack.co/transferrecipient",
            {
                type: "nuban",
                name: account_name,
                account_number,
                bank_code,
                currency: "NGN",
            },
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET}`,
                    "Content-Type": "application/json",
                },
            }
        );

        if (!response.data.status) {
            throw new Error(response.data.message || "Failed to create recipient on Paystack");
        }

        return { recipient_code: response.data.data.recipient_code };
    } catch (err) {
        console.error("Paystack createRecipient error:", err.response?.data || err.message);
        throw err;
    }
}
