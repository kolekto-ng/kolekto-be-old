import { supabase } from '../utils/client.js';

export const createCollection = async (req, res) => {
    const { title,
        description,
        amount,
        deadline,
        max_contributions,
        contributions_fields,
        status,
        fee_bearer,
        currency,
        currency_symbol,
        generate_unique_codes, code_prefix,
    } = req.body;

    if (!title || !amount) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Use authenticated user's ID as organizer_id
    const user_id = req.user.sub; // or req.user.id, depending on your JWT payloa

    // Calculate amount breakdown
    let amountbreakdown = {};
    const parsedAmount = parseFloat(amount);
    if (!isNaN(parsedAmount)) {
        let kolektoFeePercentage;
        if (parsedAmount < 1000) {
            kolektoFeePercentage = 0.03;
        } else if (parsedAmount < 5000) {
            kolektoFeePercentage = 0.025;
        } else if (parsedAmount < 20000) {
            kolektoFeePercentage = 0.02;
        } else {
            kolektoFeePercentage = 0.015;
        }

        let gatewayFee = parsedAmount * 0.015;
        gatewayFee = Math.min(gatewayFee, 2000);

        const platformFee = parsedAmount * kolektoFeePercentage;
        const totalFees = platformFee + gatewayFee;

        amountbreakdown = {
            platformFee,
            paymentGatewayFee: gatewayFee,
            totalFees,
            totalPayable:
                fee_bearer === 'contributor'
                    ? parsedAmount + totalFees
                    : parsedAmount,
        };
    }

    // Set initial values for financial fields
    // const gross_payment = parsedAmount || 0;
    // const net_payment = gross_payment - (amountbreakdown.totalFees || 0);
    // const balance = net_payment;
    // const withdrawn = 0;

    //     const gross_payment = parseFloat(amount) || 0;
    // const total_fees = amountbreakdown.totalFees || 0;
    // const net_payment = gross_payment - total_fees;
    // const withdrawn = 0;
    // const balance = net_payment - withdrawn; // On creation, this is just net_payment

    // balance = net_payment - withdrawn

    // Set initial values for financial fields
    const gross_payment = 0;
    const net_payment = 0;
    const balance = 0;
    const withdrawn = 0;
    const total_fees = 0;

    const { data, error } = await supabase
        .from('collections')
        .insert([{
            user_id,
            title,
            description,
            amount: parsedAmount,
            deadline,
            code_prefix: code_prefix || null,
            max_contributions,
            contributions_fields: contributions_fields || [],
            status: status || 'active',
            fee_bearer: fee_bearer || 'organizer',
            currency: currency || 'NGN',
            currency_symbol: currency_symbol || '₦',
            amount_breakdown: amountbreakdown,
            gross_payment,
            net_payment,
            balance,
            withdrawn,
            total_fees,
            total_contributions: 0,
        }])
        .select()
        .single();

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({ collection: data });
};

export const getUserCollections = async (req, res) => {
    const user_id = req.user.sub; // or req.user.id, depending on your JWT payload
    console.log(user_id, 'user_id in getUserCollections');

    const { data, error } = await supabase
        .from('collections')
        .select('*')
        .eq('user_id', user_id);
    // console.log('Data fetched:', data);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ data });
};

export const getSingleCollection = async (req, res) => {
    const { id } = req.params;
    const user_id = req.user.sub; // or req.user.id, depending on your JWT payload

    const { data, error } = await supabase
        .from('collections')
        .select('*')
        .eq('id', id)
        .eq('user_id', user_id) // Ensures user can only access their own collection
        .single();

    if (error) {
        return res.status(404).json({ error: error.message });
    }

    return res.status(200).json({ collection: data });
};