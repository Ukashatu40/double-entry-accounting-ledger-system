-- AlterEnum
-- Pure additive enum value — non-blocking in PostgreSQL 12+, does not
-- require ADR-006's rename/backfill pattern (that pattern is only needed
-- for destructive enum changes such as removing or renaming a value).
ALTER TYPE "TransactionType" ADD VALUE 'NIP_TRANSFER';
ALTER TYPE "TransactionType" ADD VALUE 'USSD_TRANSFER';
