/** Pure ownership gate kept separate so status safety can be unit tested. */
export function statusWriteAllowed(
  reporting: boolean,
  leaseHeld: boolean,
  generation: number,
): boolean {
  return reporting && leaseHeld && generation > 0;
}
