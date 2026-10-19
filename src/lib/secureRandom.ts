/**
 * Shared cryptographic identifier generator.
 *
 * Guaranteed RFC 4122 v4 UUID format across all platforms, including
 * Safari 15.0 - 15.3 and older Android WebViews where crypto.randomUUID
 * is not defined. Uses crypto.getRandomValues byte generation as the secure
 * fallback. Never uses Math.random.
 */

export function secureRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // RFC 4122 v4 UUID: byte 6 bits 0100xxxx (version 4), byte 8 bits 10xxxxxx (variant 1)
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  throw new Error('secure_random_unavailable');
}
