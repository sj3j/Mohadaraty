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
  STORE_ATTENDANCE_OUTBOX,
  STORE_ATTENDANCE_COMMANDS,
} from '../lib/localDb';
import {
  attendanceInstallation,
  signAttendanceMessage,
  signDeviceReceipt,
  signOfflineAttendanceQr,
} from './attendanceCrypto';
import type {
  AttendanceRepository,
  AttendanceSigner,
  CaptureInput,
  DoctorCommand,
  DoctorSessionCommit,
  DurableCaptureResult,
  PublicDeviceIdentity,
  StorageHealth,
} from './attendanceRepository';

export class IndexedDbAttendanceRepository implements AttendanceRepository {
  async initialize(): Promise<StorageHealth> {
    return this.getHealth('');
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
    await dbPut(STORE_ATTENDANCE_COMMANDS, command);
  }

  async listDoctorCommands(ownerUid: string): Promise<DoctorCommand[]> {
    return dbGetAllByIndex<DoctorCommand>(
      STORE_ATTENDANCE_COMMANDS,
      'by_owner',
      IDBKeyRange.only(ownerUid)
    );
  }

  async updateDoctorCommand(command: DoctorCommand): Promise<void> {
    await dbPut(STORE_ATTENDANCE_COMMANDS, command);
  }

  async updateReceipt(
    requestId: string,
    update: (curr: LocalAttendanceReceipt) => LocalAttendanceReceipt
  ): Promise<void> {
    return changeAttendanceReceipt(requestId, update);
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

  async signReceipt(receipt: any): Promise<string> {
    const installation = await attendanceInstallation();
    return signDeviceReceipt(installation, receipt);
  }

  async signDoctorQr(claims: any): Promise<string> {
    return signOfflineAttendanceQr(claims.permit || '', claims);
  }

  async signRotationMessage(message: string): Promise<string> {
    const installation = await attendanceInstallation();
    return signAttendanceMessage(installation.privateKey, message);
  }
}
