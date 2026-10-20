import { registerPlugin } from '@capacitor/core';
import type { LocalAttendanceReceipt } from '../../shared/attendance';
import { attendanceDeviceMessage } from '../../shared/attendanceSecurity';
import type {
  AcknowledgementItem,
  AttendanceRepository,
  AttendanceSigner,
  CaptureInput,
  DoctorCommand,
  DoctorSessionCommit,
  DurableCaptureResult,
  PublicDeviceIdentity,
  StorageHealth,
  UploadBatch,
} from './attendanceRepository';

export interface NativeStoragePlugin {
  initialize(options?: { ownerUid?: string }): Promise<{
    storageType: string;
    isDurable: boolean;
    healthState?: string;
    unresolvedReceiptsCount: number;
    unresolvedCommandsCount: number;
    unreadableRecordsCount?: number;
    oldestPendingAgeMs?: number;
    legacyMigrationPending?: boolean;
  }>;
  capture(options: { receipt: string; conflictSignature?: string }): Promise<{
    receipt: string;
    alreadySaved: boolean;
  }>;
  listReceipts(options: { ownerUid: string }): Promise<{ receipts: string[] }>;
  getReceipt(options: { requestId: string }): Promise<{ receipt?: string }>;
  commitDoctorSession(options: {
    metaKey: string;
    metaData: string;
    command: string;
  }): Promise<void>;
  enqueueDoctorCommand(options: { command: string }): Promise<void>;
  listDoctorCommands(options: { ownerUid: string }): Promise<{ commands: string[] }>;
  updateDoctorCommand(options: { command: string }): Promise<void>;
  updateReceipt(options: { requestId: string; receipt: string }): Promise<void>;
  transitionReceipt(options: {
    requestId: string;
    status: string;
    resolution?: string;
    reason?: string;
    recordRevision?: number;
  }): Promise<{ receipt?: string }>;
  acquireUploadLease(options: {
    ownerUid?: string;
    limit?: number;
    leaseDurationMs?: number;
  }): Promise<{ leaseId: string; receipts: string[] }>;
  acknowledgeBatch(options: {
    acknowledgements: Array<{
      requestId: string;
      resolution: string;
      reason?: string;
      recordId?: string;
      recordRevision?: number;
    }>;
  }): Promise<void>;
  releaseUploadLease(options: { leaseId: string }): Promise<void>;
  getMetadata(options: { key: string; ownerUid?: string }): Promise<{ value: string | null }>;
  setMetadata(options: { key: string; value: string; ownerUid?: string }): Promise<void>;
  deleteMetadata(options: { key: string; ownerUid?: string }): Promise<void>;
  recoverInterruptedWork(): Promise<void>;
  getHealth(options: { ownerUid: string }): Promise<{
    storageType: string;
    isDurable: boolean;
    healthState?: string;
    unresolvedReceiptsCount: number;
    unresolvedCommandsCount: number;
    unreadableRecordsCount?: number;
    oldestPendingAgeMs?: number;
    lastSuccessfulSync?: string;
    legacyMigrationPending?: boolean;
  }>;
  getPublicIdentity(): Promise<{
    fingerprint: string;
    publicKey: any;
    installationId: string;
  }>;
  signReceipt(options: { receipt?: string; message?: string }): Promise<{ signature: string }>;
  signDoctorQr(options: { claims: string; permit?: string }): Promise<{ signature: string }>;
  signRotationMessage(options: { message: string }): Promise<{ signature: string }>;
  migrateLegacyData(options: {
    receipts: string[];
    locks: string[];
    commands: string[];
    meta: string[];
  }): Promise<{ migratedCount: number }>;
}

export const NativeAttendanceStorage = registerPlugin<NativeStoragePlugin>('AttendanceStorage');

export class NativeAttendanceRepository implements AttendanceRepository {
  async initialize(ownerUid = ''): Promise<StorageHealth> {
    const res = await NativeAttendanceStorage.initialize({ ownerUid });
    return {
      storageType: 'native_sqlite',
      isDurable: res.isDurable ?? true,
      healthState: (res.healthState as any) || 'ready',
      unresolvedReceiptsCount: res.unresolvedReceiptsCount || 0,
      unresolvedCommandsCount: res.unresolvedCommandsCount || 0,
      unreadableRecordsCount: res.unreadableRecordsCount || 0,
      oldestPendingAgeMs: res.oldestPendingAgeMs,
      legacyMigrationPending: res.legacyMigrationPending,
    };
  }

  async capture(input: CaptureInput): Promise<DurableCaptureResult> {
    const res = await NativeAttendanceStorage.capture({
      receipt: JSON.stringify(input.receipt),
      conflictSignature: input.conflictSignature,
    });
    return {
      receipt: JSON.parse(res.receipt),
      alreadySaved: res.alreadySaved,
    };
  }

  async listReceipts(ownerUid: string): Promise<LocalAttendanceReceipt[]> {
    const res = await NativeAttendanceStorage.listReceipts({ ownerUid });
    return (res.receipts || []).map(r => JSON.parse(r));
  }

  async getReceipt(requestId: string): Promise<LocalAttendanceReceipt | null> {
    const res = await NativeAttendanceStorage.getReceipt({ requestId });
    return res.receipt ? JSON.parse(res.receipt) : null;
  }

  async commitDoctorSession(input: DoctorSessionCommit): Promise<void> {
    await NativeAttendanceStorage.commitDoctorSession({
      metaKey: input.meta.key,
      metaData: JSON.stringify(input.meta.data),
      command: JSON.stringify(input.command),
    });
  }

  async enqueueDoctorCommand(command: DoctorCommand): Promise<void> {
    await NativeAttendanceStorage.enqueueDoctorCommand({
      command: JSON.stringify(command),
    });
  }

  async listDoctorCommands(ownerUid: string): Promise<DoctorCommand[]> {
    const res = await NativeAttendanceStorage.listDoctorCommands({ ownerUid });
    return (res.commands || []).map(c => JSON.parse(c));
  }

  async updateDoctorCommand(command: DoctorCommand): Promise<void> {
    await NativeAttendanceStorage.updateDoctorCommand({
      command: JSON.stringify(command),
    });
  }

  async updateReceipt(
    requestId: string,
    update: (curr: LocalAttendanceReceipt) => LocalAttendanceReceipt
  ): Promise<void> {
    const current = await this.getReceipt(requestId);
    if (!current) return;
    const updated = update(current);
    await NativeAttendanceStorage.updateReceipt({
      requestId,
      receipt: JSON.stringify(updated),
    });
  }

  async transitionReceipt(
    requestId: string,
    status: string,
    options?: { resolution?: string; reason?: string; recordRevision?: number }
  ): Promise<LocalAttendanceReceipt | null> {
    const res = await NativeAttendanceStorage.transitionReceipt({
      requestId,
      status,
      resolution: options?.resolution,
      reason: options?.reason,
      recordRevision: options?.recordRevision,
    });
    return res.receipt ? JSON.parse(res.receipt) : null;
  }

  async acquireUploadLease(ownerUid: string, limit = 25, leaseDurationMs = 60000): Promise<UploadBatch> {
    const res = await NativeAttendanceStorage.acquireUploadLease({
      ownerUid,
      limit,
      leaseDurationMs,
    });
    return {
      leaseId: res.leaseId,
      receipts: (res.receipts || []).map(r => JSON.parse(r)),
    };
  }

  async acknowledgeBatch(leaseId: string, acknowledgements: AcknowledgementItem[]): Promise<void> {
    await NativeAttendanceStorage.acknowledgeBatch({
      acknowledgements: acknowledgements.map(a => ({
        requestId: a.requestId,
        resolution: a.resolution,
        reason: a.reason,
        recordId: a.recordId,
        recordRevision: a.recordRevision,
      })),
    });
  }

  async releaseUploadLease(leaseId: string): Promise<void> {
    await NativeAttendanceStorage.releaseUploadLease({ leaseId });
  }

  async getMetadata<T = any>(key: string, ownerUid?: string): Promise<T | null> {
    const res = await NativeAttendanceStorage.getMetadata({ key, ownerUid });
    if (!res.value) return null;
    try {
      return JSON.parse(res.value) as T;
    } catch {
      return res.value as unknown as T;
    }
  }

  async setMetadata<T = any>(key: string, data: T, ownerUid?: string): Promise<void> {
    const value = typeof data === 'string' ? data : JSON.stringify(data);
    await NativeAttendanceStorage.setMetadata({ key, value, ownerUid });
  }

  async deleteMetadata(key: string, ownerUid?: string): Promise<void> {
    await NativeAttendanceStorage.deleteMetadata({ key, ownerUid });
  }

  async recoverInterruptedWork(): Promise<void> {
    await NativeAttendanceStorage.recoverInterruptedWork();
  }

  async getHealth(ownerUid: string): Promise<StorageHealth> {
    const res = await NativeAttendanceStorage.getHealth({ ownerUid });
    return {
      storageType: 'native_sqlite',
      isDurable: res.isDurable ?? true,
      healthState: (res.healthState as any) || 'ready',
      unresolvedReceiptsCount: res.unresolvedReceiptsCount || 0,
      unresolvedCommandsCount: res.unresolvedCommandsCount || 0,
      unreadableRecordsCount: res.unreadableRecordsCount || 0,
      oldestPendingAgeMs: res.oldestPendingAgeMs,
      lastSuccessfulSync: res.lastSuccessfulSync,
      legacyMigrationPending: res.legacyMigrationPending,
    };
  }
}

export class NativeAttendanceSigner implements AttendanceSigner {
  async getPublicIdentity(): Promise<PublicDeviceIdentity> {
    const res = await NativeAttendanceStorage.getPublicIdentity();
    return {
      fingerprint: res.fingerprint,
      publicKey: typeof res.publicKey === 'string' ? JSON.parse(res.publicKey) : res.publicKey,
      installationId: res.installationId,
      legacyKeyAvailable: false,
    };
  }

  async signReceipt(receipt: any, message?: string): Promise<string> {
    const serializedMessage = message || attendanceDeviceMessage(receipt);
    const res = await NativeAttendanceStorage.signReceipt({
      message: serializedMessage,
      receipt: JSON.stringify(receipt),
    });
    return res.signature;
  }

  async signDoctorQr(claimsOrParams: any): Promise<string> {
    let permit = '';
    let claims: any = claimsOrParams;
    if (claimsOrParams && typeof claimsOrParams === 'object') {
      if ('permit' in claimsOrParams && 'claims' in claimsOrParams) {
        permit = claimsOrParams.permit;
        claims = claimsOrParams.claims;
      } else if ('permit' in claimsOrParams) {
        permit = claimsOrParams.permit;
      }
    }
    const res = await NativeAttendanceStorage.signDoctorQr({
      permit,
      claims: JSON.stringify(claims),
    });
    return res.signature;
  }

  async signRotationMessage(message: string): Promise<string> {
    const res = await NativeAttendanceStorage.signRotationMessage({ message });
    return res.signature;
  }
}
