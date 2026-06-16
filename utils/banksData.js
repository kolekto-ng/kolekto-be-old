import axios from "axios";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY?.replace(/['"\r\n\s]/g, "");

// Helper to set headers
const paystackHeaders = {
    Authorization: `Bearer ${PAYSTACK_SECRET}`,
    "Content-Type": "application/json"
};

export const getBanksData = async (req, res, next) => {
    try {
        const banksRes = await axios.get(
            "https://api.paystack.co/bank?currency=NGN",
            { headers: paystackHeaders }
        );

        // Return the body, not the entire AxiosResponse (was leaking internal axios fields).
        return res.status(200).json(banksRes.data);
    } catch (error) {
        return res.status(error?.response?.status || 502).json({
            error: error?.response?.data?.message || error?.message || "Failed to fetch banks",
        });
    }
};