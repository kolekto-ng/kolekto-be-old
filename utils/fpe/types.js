// AUTO-GENERATED from kolekto-shared-financial — DO NOT EDIT BY HAND.
// Regenerate: (in kolekto-fe-old/kolekto-shared-financial) npm run build && npm run vendor:backend
/**
 * types.ts — L0 type contracts for the Financial Projection Engine.
 *
 * These are pure type declarations (erased at runtime). They describe the
 * shapes the engine consumes and produces. Every runtime (Node, Deno) shares
 * these definitions; the SQL mirror encodes the same shapes as columns.
 *
 * DESIGN INVARIANT: the engine is a projection. Its inputs are only the two
 * immutable financial event streams — paid `contributions` and `withdrawals`.
 * Everything else (wallets) is derived output, never input.
 */
export {};
