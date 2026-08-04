-- =============================================================================
-- diagnostics_price_tiers_wiped — read-only, NOT a migration.
-- =============================================================================
-- Quantifies blast radius of the editCollection bug (controllers/collection.js
-- ~line 418: `price_tiers: collectionType === 'tiered' ? price_tiers : null`
-- omits 'ticket', so saving an edit on a ticket-type collection nulls the
-- ENTIRE price_tiers array — not just sold_quantity, the tier definitions
-- themselves). Collections caught by this have price_tiers = null and are
-- invisible to diagnostics_host_visibility_and_aggregates.sql query 6 because
-- jsonb_array_elements(NULL) returns zero rows there.
-- =============================================================================

select
    col.id as collection_id,
    col.title,
    col.collection_type,
    col.price_tiers,
    col.updated_at,
    (select count(*) from public.contributions c
      where c.collection_id = col.id and c.status = 'paid') as paid_contributions_count
from public.collections col
where col.collection_type = 'ticket'
  and col.price_tiers is null
order by paid_contributions_count desc;
-- Any row here with paid_contributions_count > 0 is a ticket collection that
-- took real money and then had its entire tier structure deleted by an edit.
-- The public /contribute page for that collection can no longer show ticket
-- categories or enforce per-category capacity.
