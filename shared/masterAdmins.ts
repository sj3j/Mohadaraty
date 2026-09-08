/**
 * The master-admin address list, in ONE place.
 *
 * It used to be an inline array literal repeated at fourteen call sites across
 * `src/`, `server.ts`, `api/index.ts` and the two rules files, and they had
 * already drifted: `LoginScreen`, `ChatScreen` and `AdminGradesScreen` still
 * carried a one-element list while the servers carried two, so an address that
 * was master admin to the API was an ordinary student to the login screen -
 * which decides the role written onto a brand-new `users` document.
 *
 * Adding an address means editing this file and the two `.rules` files, which
 * cannot import it. `npm run test:masters` fails if they disagree.
 */
export const MASTER_ADMIN_EMAILS = [
  'almdrydyl335@gmail.com',
  'dra016go@gmail.com',
  'jempe.kn@gmail.com',
] as const;

/**
 * Case-insensitive, null-safe membership test.
 *
 * Every caller was lowercasing by hand and two of them forgot, so an address
 * Google asserted with any capital letter fell through to the student path.
 */
export const isMasterAdminEmail = (email?: string | null): boolean =>
  !!email && (MASTER_ADMIN_EMAILS as readonly string[]).includes(email.toLowerCase());
