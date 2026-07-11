// tests/unit/transaction-handlers/journal-entry-assertions.util.ts
//
// Shared assertions used across handler unit tests to catch the exact class
// of bug an earlier audit found: journal entries that summed to a balanced
// trial balance (SUM(debits) == SUM(credits)) while individual account legs
// moved in the economically WRONG direction (e.g. a customer's wallet
// balance increasing when they send a payment). Trial-balance-only checks
// cannot catch this — these helpers assert on individual line direction.

export interface JournalLine {
  accountId: string;
  entryType: 'DEBIT' | 'CREDIT';
  amount: string;
}

/** Asserts SUM(debit lines) === SUM(credit lines), to full decimal precision. */
export function assertJournalBalanced(lines: JournalLine[]): void {
  const debitTotal = lines
    .filter((l) => l.entryType === 'DEBIT')
    .reduce((sum, l) => sum + parseFloat(l.amount), 0);
  const creditTotal = lines
    .filter((l) => l.entryType === 'CREDIT')
    .reduce((sum, l) => sum + parseFloat(l.amount), 0);

  expect(Math.abs(debitTotal - creditTotal)).toBeLessThan(0.00005);
}

/**
 * Asserts that the given account's derived balance change — computed the
 * SAME way BalanceService does it (SUM(debit) - SUM(credit)) — moves in the
 * expected direction for an ASSET-type account. Pass expected='increase' for
 * money entering a wallet, 'decrease' for money leaving it.
 */
export function assertAssetAccountMoves(
  lines: JournalLine[],
  accountId: string,
  expected: 'increase' | 'decrease',
): void {
  const accountLines = lines.filter((l) => l.accountId === accountId);
  expect(accountLines.length).toBeGreaterThan(0);

  const debit = accountLines
    .filter((l) => l.entryType === 'DEBIT')
    .reduce((sum, l) => sum + parseFloat(l.amount), 0);
  const credit = accountLines
    .filter((l) => l.entryType === 'CREDIT')
    .reduce((sum, l) => sum + parseFloat(l.amount), 0);
  const netChange = debit - credit; // Asset convention: Debit=Increase, Credit=Decrease

  if (expected === 'increase') {
    expect(netChange).toBeGreaterThan(0);
  } else {
    expect(netChange).toBeLessThan(0);
  }
}

/**
 * Same as assertAssetAccountMoves but for CREDIT-normal accounts
 * (Liability, Equity, Revenue) where Credit=Increase, Debit=Decrease.
 */
export function assertCreditNormalAccountMoves(
  lines: JournalLine[],
  accountId: string,
  expected: 'increase' | 'decrease',
): void {
  const accountLines = lines.filter((l) => l.accountId === accountId);
  expect(accountLines.length).toBeGreaterThan(0);

  const debit = accountLines
    .filter((l) => l.entryType === 'DEBIT')
    .reduce((sum, l) => sum + parseFloat(l.amount), 0);
  const credit = accountLines
    .filter((l) => l.entryType === 'CREDIT')
    .reduce((sum, l) => sum + parseFloat(l.amount), 0);
  const netChange = credit - debit; // Credit-normal convention: Credit=Increase, Debit=Decrease

  if (expected === 'increase') {
    expect(netChange).toBeGreaterThan(0);
  } else {
    expect(netChange).toBeLessThan(0);
  }
}
