// Helper to set headers
const paystackHeaders = {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json"
};

export const getBanksData = async (req, res, next) => {

    try {
        // 1. Get all banks from Paystack
        const banksRes = await axios.get(
            "https://api.paystack.co/bank?currency=NGN",
            { headers: paystackHeaders }
        );

        const banks = banksRes.data.data;

        res.status(200).json(banksRes);
    } catch (error) {
        return res.status(400).json(error);

    }


}