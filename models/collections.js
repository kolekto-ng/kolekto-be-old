import { DataTypes } from "sequelize";
import sequelize from "../services/sequelizeClient.js";

const Collection = sequelize.define("Collection", {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    organizer_id: {
        type: DataTypes.UUID,
        allowNull: false,
    },
    title: {
        type: DataTypes.STRING(255),
        allowNull: false,
    },
    description: {
        type: DataTypes.TEXT,
    },
    amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
    },
    currency: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: "NGN",
    },
    currency_symbol: {
        type: DataTypes.STRING(5),
        allowNull: false,
        defaultValue: "₦",
    },
    gross_payment: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
    },
    net_payment: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
    },
    balance: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
    },
    total_fees: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
    },
    total_contributions: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    max_participants: {
        type: DataTypes.INTEGER,
    },
    deadline: {
        type: DataTypes.DATE,
    },
    form_fields: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
    },
    pricing_tiers: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: "active",
    },
    fee_bearer: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: "organizer",
    },
    base_amount: {
        type: DataTypes.DECIMAL(12, 2),
    },
    kolekto_fee: {
        type: DataTypes.DECIMAL(12, 2),
    },
    payment_gateway_fee: {
        type: DataTypes.DECIMAL(12, 2),
    },
    total_payable: {
        type: DataTypes.DECIMAL(12, 2),
    },
    amountbreakdown: {
        type: DataTypes.JSONB,
        allowNull: false,
        // Example default structure:
        // defaultValue: {
        //   base_amount: null,
        //   kolekto_fee: null,
        //   payment_gateway_fee: null,
        //   total_payable: null
        // }
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
    },
    updated_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
    },
}, {
    tableName: "collections",
    timestamps: false,
});

export default Collection;