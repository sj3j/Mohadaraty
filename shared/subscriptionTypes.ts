/** Manual money accepted by staff. Kept separate from gateway/store sources so
 * paid staff activation can never accidentally accept an entitlement source. */
export const MANUAL_PAYMENT_METHODS = ['cash', 'zaincash', 'superkey', 'other'] as const;
export type ManualPaymentMethod = typeof MANUAL_PAYMENT_METHODS[number];

export type LegacyPaymentMethod = ManualPaymentMethod | 'admin_grant' | 'apple_iap';

export const PAID_MANUAL_PLANS = ['monthly', 'seasonal', 'semi_annual'] as const;
export const GRANT_PLANS = [...PAID_MANUAL_PLANS, 'annual'] as const;
export type ManagedSubscriptionPlan = typeof GRANT_PLANS[number];

export const SUPPORT_LEDGER_TYPES = [
  'credit',
  'receive_partial',
  'receive_full',
  'reset',
  'void_reversal',
  'payout',
] as const;
export type SupportLedgerType = typeof SUPPORT_LEDGER_TYPES[number];
