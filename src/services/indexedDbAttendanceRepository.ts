import type { LocalAttendanceReceipt } from '../../shared/attendance';
import {
  commitAttendanceCapture,
  commitDoctorAttendanceSession,
  getAttendanceReceipt,
  listAttendanceReceipts,
  changeAttendanceReceipt,
  dbGet,
  dbGetAllByIndex,
  dbPut,
  dbDelete,
  STORE_ATTENDANCE_OUTBOX,
  STORE_ATTENDANCE_COMMANDS,
  STORE_META,
  transactAttendanceReceipts,
  attendanceDurablePut,
} from '../lib/localDb';
import {
  attendanceInstallation,
  signAttendanceMessage,
  signDeviceReceipt,
  signOfflineAttendanceQr,
} from './attendanceCrypto';
import { secureRequestId } from '../lib/secureRandom';
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

export class IndexedDbAttendanceRepository implements AttendanceRepository {
  async initialize(ownerUid = ''): Promise<StorageHealth> {
    return this.getHealth(ownerUid);
  }

  async capture(input: CaptureInput): Promise<DurableCaptureResult> {
    return commitAttendanceCapture(input.receipt, input.conflictSignature);
  }

  async listReceipts(ownerUid: string): Promise<LocalAttendanceReceipt[]> {
    return listAttendanceReceipts<LocalAttendanceReceipt>(ownerUid);
  }

  async getReceipt(requestId: string): Promise<LocalAttendanceReceipt | null> {
    const item = await getAttendanceReceipt<LocalAttendanceReceipt>(requestId);
    return item ?? null;
  }

  async commitDoctorSession(input: DoctorSessionCommit): Promise<void> {
    return commitDoctorAttendanceSession(input.meta, input.command);
  }

  async enqueueDoctorCommand(command: DoctorCommand): Promise<void> {
    await commitDoctorAttendanceSession({ key: 'attendance-command-sequence-owner', data: null }, command);
  }

  async listDoctorCommands(ownerUid: string): Promise<DoctorCommand[]> {
    return dbGetAllByIndex<DoctorCommand>(
      STORE_ATTENDANCE_COMMANDS,
      'by_owner',
      IDBKeyRange.only(ownerUid)
    );
  }

  async updateDoctorCommand(command: DoctorCommand): Promise<void> {
    await attendanceDurablePut(STORE_ATTENDANCE_COMMANDS, command);
  }

  async updateReceipt(
    requestId: string,
    update: (curr: LocalAttendanceReceipt) => LocalAttendanceReceipt
  ): Promise<void> {
    return changeAttendanceReceipt(requestId, update);
  }

  async transitionReceipt(
    requestId: string,
    status: string,
    options?: { resolution?: string; reason?: string; recordRevision?: number }
  ): Promise<LocalAttendanceReceipt | null> {
    let result: LocalAttendanceReceipt | null = null;
    await changeAttendanceReceipt(requestId, curr => {
      if (options?.recordRevision && (curr.recordRevision || 0) > options.recordRevision) {
        result = curr;
        return curr;
      }
      const updated: LocalAttendanceReceipt = {
        ...curr,
        status: status as any,
        resolution: (options?.resolution as any) ?? curr.resolution,
        reason: options?.reason ?? curr.reason,
        recordRevision: options?.recordRevision ?? curr.recordRevision,
        updatedAt: Date.now(),
      };
      result = updated;
      return updated;
    });
    return result;
  }

  async acquireUploadLease(ownerUid: string, limit = 25, leaseDurationMs = 60000): Promise<UploadBatch> {
    return transactAttendanceReceipts((all, put) => {
      const now = Date.now();
      const leaseId = secureRequestId();
      const receipts = all.filter(r => r.ownerUid === ownerUid &&
        ['pending', 'syncing', 'waiting_for_login'].includes(r.status) &&
        (!r.leaseId || !r.leaseExpiresAt || r.leaseExpiresAt <= now || r.leaseExpiresAt > now + leaseDurationMs))
        .sort((a, b) => a.savedAt - b.savedAt).slice(0, Math.min(25, Math.max(1, limit)));
      for (const r of receipts) put({ ...r, leaseId, leaseExpiresAt: now + leaseDurationMs });
      return { receipts, leaseId };
    });
  }

  async acknowledgeBatch(leaseId: string, acknowledgements: AcknowledgementItem[]): Promise<void> {
    await transactAttendanceReceipts((all, put) => {
      for (const ack of acknowledgements) {
      const current = all.find(r => r.requestId === ack.requestId);
      if (!current || current.leaseId !== leaseId) throw new Error('attendance_lease_mismatch');
      if ((current.recordRevision || 0) > (ack.recordRevision || 0)) continue;
      const newStatus =
        ack.resolution === 'confirmed' || ack.resolution === 'already_recorded'
          ? 'confirmed'
          : ack.resolution === 'needs_review'
            ? 'review'
            : ack.resolution === 'invalid_evidence'
              ? 'invalid'
              : 'pending';
      put({
        ...current, ...ack, resolution: ack.resolution as LocalAttendanceReceipt['resolution'],
        status: newStatus, updatedAt: Date.now(), leaseId: undefined, leaseExpiresAt: undefined,
      });
      }
    });
  }

  async releaseUploadLease(leaseId: string): Promise<void> {
    await transactAttendanceReceipts((all, put) => {
      for (const r of all) if (r.leaseId === leaseId) put({ ...r, leaseId: undefined, leaseExpiresAt: undefined });
    });
  }

  async getMetadata<T = any>(key: string, ownerUid?: string): Promise<T | null> {
    const scopedKey = ownerUid ? `${key}:${ownerUid}` : key;
    const item = await dbGet<{ data: T } | T>(STORE_META, scopedKey);
    if (!item) {
      if (ownerUid) {
        // Fallback to unscoped key
        const unscoped = await dbGet<{ data: T } | T>(STORE_META, key);
        if (!unscoped || ((unscoped as any).ownerUid !== ownerUid &&
          (unscoped as any).data?.ownerUid !== ownerUid &&
          !key.startsWith(`attendance-pack:${ownerUid}:`) &&
          !key.startsWith(`attendance-doctor:${ownerUid}:`) &&
          !key.startsWith(`attendance-workspace:${ownerUid}:`))) return null;
        return (unscoped as any).data !== undefined ? (unscoped as any).data : (unscoped as T);
      }
      return null;
    }
    return (item as any).data !== undefined ? (item as any).data : (item as T);
  }

  async setMetadata<T = any>(key: string, data: T, ownerUid?: string): Promise<void> {
    const scopedKey = ownerUid ? `${key}:${ownerUid}` : key;
    await attendanceDurablePut(STORE_META, { key: scopedKey, ownerUid, data, updatedAt: Date.now() });
  }

  async deleteMetadata(key: string, ownerUid?: string): Promise<void> {
    const scopedKey = ownerUid ? `${key}:${ownerUid}` : key;
    await dbDelete(STORE_META, scopedKey);
  }

  async recoverInterruptedWork(): Promise<void> {
    // IndexedDB operations are committed with strict durability transactions.
  }

  async getHealth(ownerUid: string): Promise<StorageHealth> {
    let unresolvedReceiptsCount = 0;
    let unresolvedCommandsCount = 0;
    try {
      if (ownerUid) {
        const receipts = await this.listReceipts(ownerUid);
        unresolvedReceiptsCount = receipts.filter(r => r.status === 'pending').length;
        const commands = await this.listDoctorCommands(ownerUid);
        unresolvedCommandsCount = commands.filter(c => c.status !== 'synced').length;
      }
    } catch {
      // Best effort health check
    }

    return {
      storageType: 'indexeddb',
      isDurable: false, // Browser IndexedDB is subject to OS eviction / site data clearing
      healthState: 'ready',
      unresolvedReceiptsCount,
      unresolvedCommandsCount,
    };
  }
}

export class IndexedDbAttendanceSigner implements AttendanceSigner {
  async getPublicIdentity(): Promise<PublicDeviceIdentity> {
    const installation = await attendanceInstallation();
    const x = installation.publicKey.x || '';
    const y = installation.publicKey.y || '';
    const fingerprint = JSON.stringify(['P-256', x, y]);
    return {
      fingerprint,
      publicKey: installation.publicKey,
      installationId: installation.value,
      legacyKeyAvailable: true,
    };
  }

  async signReceipt(receipt: any, message?: string): Promise<string> {
    const installation = await attendanceInstallation();
    if (message) {
      return signAttendanceMessage(installation.privateKey, message);
    }
    return signDeviceReceipt(installation, receipt);
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
    return signOfflineAttendanceQr(permit || claims?.permit || '', claims);
  }

  async signRotationMessage(message: string): Promise<string> {
    const installation = await attendanceInstallation();
    return signAttendanceMessage(installation.privateKey, message);
  }
}
