import { InterestPayoutHandler } from '@transactions/handlers/interest-payout.handler';
import type { Account } from '@prisma/client';

describe('InterestPayoutHandler', () => {
  let handler: InterestPayoutHandler;

  beforeEach(() => {
    handler = new InterestPayoutHandler();
  });

  it('rejects a zero or negative gross interest amount', () => {
    expect(() =>
      (
        handler as unknown as {
          validateBusinessRules: (
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => Promise<void>;
        }
      ).validateBusinessRules({ grossInterest: '0.0000' }, {}),
    ).toThrow('must be positive');
  });

  it('passes for a valid gross interest amount', async () => {
    await expect(
      (
        handler as unknown as {
          validateBusinessRules: (
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => Promise<void>;
        }
      ).validateBusinessRules({ grossInterest: '1000.0000' }, {}),
    ).resolves.not.toThrow();
  });
});
