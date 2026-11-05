-- Workflow approval step: a thread waiting on a person's decision about an invoice.
-- Additive. An enum value can't be dropped in Postgres, but nothing depends on it unless used.
ALTER TYPE "ApprovalType" ADD VALUE IF NOT EXISTS 'INVOICE_DUNNING';
