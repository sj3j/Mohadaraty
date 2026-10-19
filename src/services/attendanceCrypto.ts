import { attendanceDeviceMessage } from '../../shared/attendanceSecurity';
import { dbGet, getOrCreateAttendanceInstallation, STORE_META, type AttendanceInstallation } from '../lib/localDb';

import { secureRequestId } from '../lib/secureRandom';

export function attendanceRequestId(): string {
  return secureRequestId();
}

export async function attendanceInstallation(): Promise<AttendanceInstallation> {
  const existing = await dbGet<AttendanceInstallation>(STORE_META, 'attendance_installation_id');
  if (existing?.privateKey) return existing;
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  return getOrCreateAttendanceInstallation({
    key: 'attendance_installation_id', value: attendanceRequestId(), privateKey: keys.privateKey,
    publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey),
  });
}

export async function signAttendanceMessage(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signDeviceReceipt(installation: AttendanceInstallation, receipt: Parameters<typeof attendanceDeviceMessage>[0]): Promise<string> {
  return signAttendanceMessage(installation.privateKey, attendanceDeviceMessage(receipt));
}

export async function signOfflineAttendanceQr(permit: string, claims: import('../../shared/attendance').AttendanceQrClaims): Promise<string> {
  const installation = await attendanceInstallation();
  const encode = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const message = `${encode({ alg: 'ES256', typ: 'JWT', permit })}.${encode(claims)}`;
  const token = `${message}.${await signAttendanceMessage(installation.privateKey, message)}`;
  if (new TextEncoder().encode(token).length > 2330) throw new Error('attendance_qr_too_large');
  return token;
}
