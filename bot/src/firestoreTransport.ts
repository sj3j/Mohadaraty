export type FirestoreTransport = 'rest' | 'grpc';

/**
 * REST is the safe default for panel hosts. Firestore transactions, reads and
 * writes all support it; only snapshot listeners require gRPC.
 */
export function parseFirestoreTransport(raw: string | undefined): FirestoreTransport {
  const value = raw?.trim().toLowerCase() || 'rest';
  if (value === 'rest' || value === 'grpc') return value;
  throw new Error(`FIRESTORE_TRANSPORT must be "rest" or "grpc", received ${JSON.stringify(raw)}`);
}

export const firestoreStreamsEnabled = (transport: FirestoreTransport): boolean =>
  transport === 'grpc';

export const firestoreSettings = (
  transport: FirestoreTransport,
): { preferRest: true } | Record<string, never> =>
  transport === 'rest' ? { preferRest: true } : {};
