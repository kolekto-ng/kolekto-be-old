// Normalizes a `contributions` row before it leaves the API so that
// mixed/older production shapes (different column names, contributor info
// stored under a different key, etc.) all resolve to one consistent shape.
//
// This is read-side only — it never writes back to the database, and never
// changes amount/wallet/payment-verification logic. It exists purely so
// `/api/contributions` returns a row that the frontend can render without
// every consumer having to re-implement its own fallback chain.

function getNestedValue(source, path) {
    return path.split(".").reduce((value, key) => {
        if (value == null) return undefined;
        return value[key];
    }, source);
}

function firstPresent(source, paths) {
    for (const path of paths) {
        const value = getNestedValue(source, path);
        if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
}

function parseIfJsonString(value) {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return value;
    try {
        return JSON.parse(trimmed);
    } catch {
        return value;
    }
}

// All the places contributor-submitted data could live across schema
// revisions. `contributor_information` (array) is the current/canonical
// shape; everything else is defensive fallback for older/differently
// shaped rows.
function getContributorInformation(row) {
    const candidates = [
        parseIfJsonString(row.contributor_information),
        parseIfJsonString(row.contact_info),
        parseIfJsonString(row.metadata),
        parseIfJsonString(row.customFields),
        parseIfJsonString(row.custom_fields),
        parseIfJsonString(row.formData),
        parseIfJsonString(row.answers),
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length > 0) return candidate;
        if (candidate && typeof candidate === "object") return [candidate];
    }
    return [];
}

function mergeInformationObject(infoRows) {
    return infoRows.reduce((acc, entry) => {
        if (!entry || typeof entry !== "object") return acc;
        for (const [key, value] of Object.entries(entry)) {
            if (acc[key] === undefined || acc[key] === null || acc[key] === "") {
                acc[key] = value;
            }
        }
        return acc;
    }, {});
}

/**
 * Normalizes a single contributions row. Always preserves every original
 * column (spread first) and only fills in/aliases on top — never removes or
 * overwrites a populated field with empty data.
 */
function normalizeContributorRow(row) {
    if (!row || typeof row !== "object") return row;

    const name = String(
        firstPresent(row, ["name", "contributor_name", "full_name", "fullName", "contributorName"]) || ""
    ).trim();
    const email = String(
        firstPresent(row, ["email", "contributor_email", "contributorEmail"]) || ""
    ).trim();
    const phone = String(
        firstPresent(row, ["phone", "contributor_phone", "phoneNumber", "contributorPhone"]) || ""
    ).trim();
    const paymentReference = String(
        firstPresent(row, ["payment_id", "payment_reference", "paymentReference", "transactionRef"]) || ""
    ).trim();
    const uniqueCode = String(
        firstPresent(row, ["contributor_unique_code", "uniqueCode", "ticket_code", "ticketCode"]) || ""
    ).trim();
    const amountValue = firstPresent(row, [
        "amount", "paidAmount", "paid_amount", "totalAmount", "total_amount", "amount_paid",
    ]);
    const amount = Number.isFinite(Number(amountValue)) ? Number(amountValue) : 0;

    const contributorInformation = getContributorInformation(row);
    const infoObject = mergeInformationObject(contributorInformation);

    const tierName = String(firstPresent(infoObject, ["Tier", "tierName", "tier_name"]) || "").trim();
    const tierId = String(firstPresent(infoObject, ["TierId", "tierId", "tier_id"]) || "").trim();
    const quantityValue = firstPresent(infoObject, ["Quantity", "quantity", "ticketQuantity", "ticket_quantity"]);
    const quantity = Number.isFinite(Number(quantityValue)) && Number(quantityValue) > 0 ? Number(quantityValue) : 1;

    return {
        ...row,
        name,
        email,
        phone,
        amount: row.amount ?? amount,
        contributor_name: row.contributor_name ?? name,
        contributor_email: row.contributor_email ?? email,
        contributor_phone: row.contributor_phone ?? phone,
        payment_id: row.payment_id ?? paymentReference,
        payment_reference: row.payment_reference ?? paymentReference,
        contributor_unique_code: row.contributor_unique_code ?? uniqueCode,
        contributor_information: contributorInformation,
        tier_name: tierName,
        tier_id: tierId,
        quantity,
        check_in_status: row.check_in_status ?? "not_checked_in",
        status: row.status ?? "pending",
    };
}

function normalizeContributorRows(rows) {
    return (rows || []).map(normalizeContributorRow);
}

export { normalizeContributorRow, normalizeContributorRows };
