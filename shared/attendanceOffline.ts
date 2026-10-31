import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { AttendanceOfflinePermitClaims, AttendanceQrClaims } from './attendance.js';

export function attendanceSessionId(occurrenceId: string): string {
  const hash = crypto.createHash('sha256').update(`simosan-occurrence:${occurrenceId}`).digest();
  hash[6] = (hash[6] & 15) | 80;
  hash[8] = (hash[8] & 63) | 128;
  const value = hash.toString('hex').slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function validateAttendancePublicKey(raw: unknown): JsonWebKey {
  const key = raw as JsonWebKey | undefined;
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || key.d || !/^[\w-]{43}$/.test(key.x || '') || !/^[\w-]{43}$/.test(key.y || '')) throw new Error('invalid_public_key');
  const result = { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
  crypto.createPublicKey({ key: result, format: 'jwk' });
  return result;
}

export function verifyOfflineAttendanceToken(token: string, verifyPermit: (permit: string) => AttendanceOfflinePermitClaims): { claims: AttendanceQrClaims; permit: AttendanceOfflinePermitClaims; credential: string } | null {
  if (typeof token !== 'string' || token.length > 4096) throw new Error('invalid_qr');
  const header = jwt.decode(token, { complete: true })?.header as jwt.JwtHeader & { permit?: string } | undefined;
  if (!header?.permit) return null;
  const permit = verifyPermit(header.permit);
  if (permit.typ !== 'simosan-offline-permit' || !permit.id || !permit.professorUid || !permit.stageId) throw new Error('invalid_permit');
  const key = crypto.createPublicKey({ key: validateAttendancePublicKey(permit.publicKey) as crypto.JsonWebKey, format: 'jwk' });
  let claims: AttendanceQrClaims;
  try { claims = jwt.verify(token, key, { algorithms: ['ES256'] }) as AttendanceQrClaims; }
  catch { throw new Error('invalid_qr'); }
  if ((claims.v !== 1 && claims.v !== 2) || claims.typ !== 'simosan-attendance' || claims.stageId !== permit.stageId
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.sessionId)
    || !/^[0-9a-f-]{36}$/i.test(claims.challengeId)
    || (claims.attemptGeneration != null && (!Number.isInteger(claims.attemptGeneration) || claims.attemptGeneration < 1))
    || (claims.v === 1 && (!Number.isInteger(claims.expectedHeadcount) || claims.expectedHeadcount! < 1 || claims.expectedHeadcount! > 10000))) throw new Error('invalid_qr');
  return { claims, permit, credential: header.permit };
}
