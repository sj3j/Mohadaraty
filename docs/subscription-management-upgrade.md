# Subscription management upgrade

## Scope and compatibility

The upgrade targets the default Standard Firestore database. It does not change Firebase Authentication, the email-as-UID convention, ZainCash/Super Qi settlement, RevenueCat/Apple IAP, or the scheduled expiry/reminder functions. `subscriptions` remains the operational entitlement and legacy payment projection. There is intentionally no migration or backfill.

Both `server.ts` (development) and `api/index.ts` (Vercel production) mount handlers from `shared/subscriptionManagement.ts`. New behavior must stay in that factory rather than being copied into either entry point.

## Collections

- `subscriptionRecords/{requestId}` is the immutable private audit record. It stores the canonical payload hash, unique reference code, student/actor snapshots, action/source, plan/price, optional method/reason, entitlement ID, exact previous presence/value for the three cached subscription fields, and one-time void links.
- `subscriptions/{requestId}` remains the sanitized operational projection consumed by existing functions. New manual/grant rows carry `auditedRecordId`; the legacy extend/cancel routes reject those rows.
- `supportBalances/{supportUid}` stores outstanding and lifetime credited/received/reset/reversed/paid-out totals plus an integer commission snapshot (currently zero).
- `supportLedger/{requestId}` stores an immutable positive amount, signed balance delta, balance after, actor and optional record/note. Types are `credit`, `receive_partial`, `receive_full`, `reset`, `void_reversal`, and `payout`.
- `referenceCodes/{code}` reserves human references in the same transaction as the target write.
- `subscriptionRequests/{requestId}` stores idempotency results for Support enable/disable/removal writes that do not create an audit or ledger row.

Client writes to the private collections are denied. Students create only the existing strictly validated pending Super Qi projection and read their own sanitized subscription data through `/api/subscriptions/mine`.

## Permissions

`shared/staffCapabilities.ts` is the application source of truth. Enabled Support accounts require an explicitly stored `true` for each of `canActivate`, `canViewHistory`, `canViewOwnBalance`, and `canViewExpiring`. The legacy `manageSubscriptions` key provides no new capability. `canGrant`, `canSettle`, `canVoid`, `canViewAllBalances`, `canViewReports`, and `canManageSupportStatus` are Master-only regardless of stored data. `staffDisabled` overrides every Support capability in the backend, client predicates, and Rules.

Rules duplicate this matrix because they cannot import TypeScript. The Rules suite contains a source-parity assertion.

## API surface

- `GET /api/subscriptions/mine`
- `GET /api/subscriptions/preview`
- `POST /api/subscriptions/manual-activate`
- `POST /api/subscriptions/grant`
- `POST /api/subscriptions/supports/:supportUid/receive|reset|payout`
- `POST /api/subscriptions/records/:recordId/void`
- `GET /api/subscriptions/history|balances|reports|expiring`
- `POST /api/admin/supports/:uid/status`
- `DELETE /api/admin/supports/:uid`

All management writes require a client request ID. The server hashes a canonical normalized payload with SHA-256. Reusing the ID with the same payload returns the stored result; a different payload returns `409 IDEMPOTENCY_CONFLICT`.

## Transactional invariants

- Student time stacks from a future active cached expiry and otherwise starts at authoritative server time. The user document is read inside the transaction, so concurrent grants retry and stack.
- Paid activation accepts monthly, seasonal, and semi-annual only. Annual is accepted only by a Master grant, which records amount zero and no payment method.
- A current preview state token is mandatory for manual confirmation. A changed cache returns `409 PREVIEW_STALE`.
- Support credit is the full server-side plan price. Master activations/grants never credit a Support balance.
- Receipt/reset/payout checks `expectedOutstanding` in the transaction. Reset only handles positive balances and is not received money. Payout handles the entire absolute negative balance and reaches exactly zero.
- Only a void reversal may create a negative balance. Void is Master-only, applies only to the latest subscription-affecting event, restores field presence and value exactly, and retains lifetime credited totals while increasing `totalReversed`.
- Reference codes use cryptographic sampling from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, reserve transactionally, and retry at most ten collisions.
- FCM is sent only after a new activation/grant commit. Its payload contains only plan and new expiry; missing tokens and messaging failures are non-fatal, and idempotent replay does not resend.

## Queries and indexes

Composite indexes cover active expiring users, student/staff history with deterministic document-ID ordering, Support ledger ordering, and operational subscription ordering. History merges private and legacy pages with independent opaque cursor positions, filters exact identities/reference codes, and drops the duplicated operational projection.

Reports use Asia/Baghdad start-inclusive/end-exclusive UTC bounds. Because the installed Admin SDK does not expose sum aggregation, only bounded range documents are read and reduced as safe integers on the server. Apple IQD revenue is excluded and audited voids are excluded.

## Rollout risks

- Deploying application code before Rules/indexes may cause permission-denied or missing-index errors. Deployments are intentionally outside this change request.
- Existing `manageSubscriptions` Support accounts receive no automatic new grants; a Master must tick each new permission.
- Old rows remain legacy rows with `-` for internal tag/reason/reference. No historical balances are inferred.
- Direct clients cached before the Rules change may still attempt subscription reads; the maintained web client now uses the sanitized API.
- Support removal and permanent account deletion can fail with `NON_ZERO_SUPPORT_BALANCE` until a positive receipt/reset or negative payout settles the account.
