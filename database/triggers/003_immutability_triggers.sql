-- prisma/migrations/manual/003_immutability_triggers.sql
-- =============================================================================
-- IMMUTABILITY TRIGGERS
-- Enforces the no-mutation principle at the database level.
-- Even if application code has a bug, these triggers prevent any UPDATE or
-- DELETE on posted ledger entries and exchange rate snapshots.
-- =============================================================================

-- ── Prevent UPDATE on POSTED ledger entries ───────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_ledger_entry_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow status transition from PENDING → POSTED (the only allowed update)
  IF OLD.status = 'PENDING' AND NEW.status = 'POSTED' THEN
    RETURN NEW;
  END IF;

  -- Allow status transition from POSTED → REVERSED (marking entry as reversed)
  IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED' THEN
    RETURN NEW;
  END IF;

  -- Block all other updates on POSTED entries
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION
      'IMMUTABILITY_VIOLATION: Cannot update a POSTED ledger entry (id=%). '
      'Create a reversal entry instead. '
      'Ref: Spec A2.2, RBI Master Directions, SOX compliance.',
      OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_ledger_entry_update ON ledger_entries;
CREATE TRIGGER trg_prevent_ledger_entry_update
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION prevent_ledger_entry_mutation();

-- ── Prevent DELETE on any ledger entry ───────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_ledger_entry_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'IMMUTABILITY_VIOLATION: Cannot delete ledger entry (id=%). '
    'Ledger entries are permanent. Create a reversal entry to correct errors. '
    'Ref: Spec A2.2, RBI Master Directions, SOX Section 802.',
    OLD.id
  USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_ledger_entry_delete ON ledger_entries;
CREATE TRIGGER trg_prevent_ledger_entry_delete
  BEFORE DELETE ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION prevent_ledger_entry_delete();

-- ── Prevent UPDATE/DELETE on exchange rate snapshots ─────────────────────────
-- Rates are immutable — only new snapshots are inserted.
-- The validUntil field IS allowed to be updated (closing a rate when a new one arrives).
CREATE OR REPLACE FUNCTION prevent_exchange_rate_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow closing a rate (setting valid_until) — this is how we supersede rates
  IF OLD.valid_until IS NULL AND NEW.valid_until IS NOT NULL THEN
    -- Only valid_until can change
    IF OLD.rate           = NEW.rate
    AND OLD.inverse_rate  = NEW.inverse_rate
    AND OLD.base_currency = NEW.base_currency
    AND OLD.quote_currency= NEW.quote_currency
    AND OLD.source        = NEW.source
    THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'IMMUTABILITY_VIOLATION: Cannot modify exchange rate snapshot (id=%). '
    'Insert a new snapshot instead. Only valid_until may be set when closing a rate.',
    OLD.id
  USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_exchange_rate_update ON exchange_rate_snapshots;
CREATE TRIGGER trg_prevent_exchange_rate_update
  BEFORE UPDATE ON exchange_rate_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION prevent_exchange_rate_mutation();

DROP TRIGGER IF EXISTS trg_prevent_exchange_rate_delete ON exchange_rate_snapshots;
CREATE TRIGGER trg_prevent_exchange_rate_delete
  BEFORE DELETE ON exchange_rate_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION prevent_ledger_entry_delete();

-- ── Verify triggers are installed ────────────────────────────────────────────
-- ledger_entries is a partitioned table — PostgreSQL clones a trigger
-- defined on the partitioned parent into every partition, so counting all
-- rows matching these trigger names would count once per partition (dozens
-- of rows), not once per trigger. Scope to the two parent tables only.
DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.triggers
    WHERE trigger_name IN (
      'trg_prevent_ledger_entry_update',
      'trg_prevent_ledger_entry_delete',
      'trg_prevent_exchange_rate_update',
      'trg_prevent_exchange_rate_delete'
    )
    AND event_object_table IN ('ledger_entries', 'exchange_rate_snapshots')
  ) = 4,
  'Expected 4 immutability triggers to be installed';

  RAISE NOTICE 'Immutability triggers installed and verified (4 triggers)';
END;
$$;