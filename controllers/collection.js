import { supabase } from '../utils/client.js';

export const createCollection = async (req, res) => {

    const {
        title, description, amount, deadline, max_contributions,
        contributions_fields, status, fee_bearer, currency, currency_symbol,
        generate_unique_codes, code_prefix,
    } = req.body;

    if (!title || !amount) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate amount
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 100) {
        return res.status(400).json({ error: 'Amount must be greater than ₦100' });
    }

    // Validate deadline
    if (!deadline || isNaN(Date.parse(deadline)) || new Date(deadline) <= new Date()) {
        return res.status(400).json({ error: 'Deadline must be a valid date in the future' });
    }

    const user_id = req.user.sub;

    // Calculate amount breakdown
    let amountBreakdown = {};

    if (!isNaN(parsedAmount)) {
        let kolektoFee;

        if (parsedAmount < 1000) {
            kolektoFee = 30;
        } else if (parsedAmount <= 5000) {
            kolektoFee = 50;
        } else if (parsedAmount <= 10000) {
            kolektoFee = 100;
        } else if (parsedAmount <= 20000) {
            kolektoFee = 200;
        } else {
            kolektoFee = Math.min(parsedAmount * 0.01, 2000);
        }

        let gatewayFee = parsedAmount * 0.015;
        gatewayFee = Math.min(gatewayFee, 2000);

        const totalFees = kolektoFee + gatewayFee;


        amountBreakdown = {
            amount: parsedAmount,
            fee_bearer: fee_bearer || 'organizer',
            platformFee: kolektoFee,
            paymentGatewayFee: gatewayFee,
            totalFees,
            totalPayable:
                fee_bearer === 'contributor'
                    ? parsedAmount + totalFees
                    : parsedAmount,
        };
    }

    // Set initial values for financial fields
    const gross_payment = 0;
    const net_payment = 0;
    const balance = 0;
    const withdrawn = 0;
    const total_fees = 0;

    // 1. Create collection
    const { data: collection, error } = await supabase
        .from('collections')
        .insert([{
            user_id,
            title,
            description,
            amount: parsedAmount,
            type: "normal",
            deadline,
            code_prefix: code_prefix || null,
            max_contributions,
            contributions_fields: contributions_fields || [],
            status: status || 'active',
            fee_bearer: fee_bearer || 'organizer',
            currency: currency || 'NGN',
            currency_symbol: currency_symbol || '₦',
            total_contributions: 0,
        }])
        .select()
        .single();

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    // 2. Create wallet for this collection
    const { error: walletError } = await supabase
        .from('wallets')
        .insert([{
            collection_id: collection.id,
            available_balance: 0,
            ledger_balance: 0,
            withdrawn: 0,
            fee_breakdown: amountBreakdown,
            currency: collection.currency,
            currency_symbol: collection.currency_symbol,
        }]);

    // 3. Rollback if wallet creation fails
    if (walletError) {
        // Delete the collection to rollback

        await supabase.from('collections').delete().eq('id', collection.id);
        return res.status(500).json({ error: "Collection created but wallet creation failed: " + walletError.message });
    }

    return res.status(201).json({ collection });
};

export const getUserCollections = async (req, res) => {
    const user_id = req.user.sub; // or req.user.id, depending on your JWT payload

    const { data, error } = await supabase
        .from('collections')
        .select(`
            *,
            wallets (
                id,
                available_balance,
                ledger_balance,
                gross_payment,
                net_payment,
                withdrawn,
                fee_breakdown,
                currency,
                currency_symbol
            )
        `)
        .eq('user_id', user_id);

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
        .select(`
            *,
            wallets (
                id,
                available_balance,
                ledger_balance,
                gross_payment,
                net_payment,
                withdrawn,
                fee_breakdown,
                currency,
                currency_symbol
            )
        `)
        .eq('id', id)
        .eq('user_id', user_id)
        .single();

    if (error) {
        return res.status(404).json({ error: error.message });
    }

    return res.status(200).json({ collection: data });
};