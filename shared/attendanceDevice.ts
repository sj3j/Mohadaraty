import crypto from 'node:crypto';
import { attendanceDeviceMessage } from './attendanceSecurity.js';

function digest(value: string): string {
  const secret = process.env.ATTENDANCE_INSTALLATION_SECRET;
  if (!secret || secret.length < 32) throw new Error('attendance_installation_secret_not_configured');
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function verifyAttendanceDevice(receipt: any): { deviceDigest: string | null; installationDigest: string | null } {
  const key = receipt.devicePublicKey;
  if (!key || !receipt.deviceSignature) return { deviceDigest: null, installationDigest: null };
  if (key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || !/^[A-Za-z0-9_-]{43}$/.test(key.y)
    || typeof receipt.deviceSignature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(receipt.deviceSignature)) throw new Error('invalid_device_proof');
  let verified = false;
  try {
    const publicKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, format: 'jwk' });
    verified = crypto.verify('sha256', Buffer.from(attendanceDeviceMessage(receipt)), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(receipt.deviceSignature, 'base64url'));
  } catch {
    throw new Error('invalid_device_proof');
  }
  if (!verified) throw new Error('invalid_device_proof');
  const fingerprint = JSON.stringify(['P-256', key.x, key.y]);
  return { deviceDigest: digest(`device:${fingerprint}`), installationDigest: digest(`session:${receipt.sessionId}:${fingerprint}`) };
}

export function deviceFingerprint(key: any): string {
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || !/^[A-Za-z0-9_-]{43}$/.test(key.y)) {
    throw new Error('invalid_key');
  }
  return JSON.stringify(['P-256', key.x, key.y]);
}

export function computeDeviceDigest(key: any): string {
  return digest(`device:${deviceFingerprint(key)}`);
}

export function attendanceRotationMessage(params: {
  actorUid: string;
  challengeId: string;
  nonce: string;
  oldFingerprint: string;
  newFingerprint: string;
}): string {
  return [
    'MYLECTURE_ATTENDANCE_KEY_ROTATION_V1',
    params.actorUid,
    params.challengeId,
    params.nonce,
    params.oldFingerprint,
    params.newFingerprint,
  ].join('\n');
}

export function verifyAttendanceKeyRotation(params: {
  actorUid: string;
  challengeId: string;
  nonce: string;
  oldKey: any;
  newKey: any;
  oldSignature: string;
  newSignature: string;
}): { oldDeviceDigest: string; newDeviceDigest: string } {
  const oldFingerprint = deviceFingerprint(params.oldKey);
  const newFingerprint = deviceFingerprint(params.newKey);
  if (oldFingerprint === newFingerprint) throw new Error('identical_keys');
  if (typeof params.oldSignature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(params.oldSignature)
    || typeof params.newSignature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(params.newSignature)) {
    throw new Error('invalid_rotation_signatures');
  }

  const message = attendanceRotationMessage({
    actorUid: params.actorUid,
    challengeId: params.challengeId,
    nonce: params.nonce,
    oldFingerprint,
    newFingerprint,
  });
  const messageBuffer = Buffer.from(message);

  let oldVerified = false;
  try {
    const oldPubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: params.oldKey.x, y: params.oldKey.y }, format: 'jwk' });
    oldVerified = crypto.verify('sha256', messageBuffer, { key: oldPubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(params.oldSignature, 'base64url'));
  } catch {
    throw new Error('invalid_old_signature');
  }
  if (!oldVerified) throw new Error('invalid_old_signature');

  let newVerified = false;
  try {
    const newPubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: params.newKey.x, y: params.newKey.y }, format: 'jwk' });
    newVerified = crypto.verify('sha256', messageBuffer, { key: newPubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(params.newSignature, 'base64url'));
  } catch {
    throw new Error('invalid_new_signature');
  }
  if (!newVerified) throw new Error('invalid_new_signature');

  return {
    oldDeviceDigest: digest(`device:${oldFingerprint}`),
    newDeviceDigest: digest(`device:${newFingerprint}`),
  };
}

