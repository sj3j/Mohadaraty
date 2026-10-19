import { registerPlugin } from '@capacitor/core';
import type { LocalAttendanceReceipt } from '../../shared/attendance';
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

export interface NativeStoragePlugin {
  initialize(): Promise<{
    storageType: string;
    isDurable: boolean;
    unresolvedReceiptsCount: number;
    unresolvedCommandsCount: number;
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
  recoverInterruptedWork(): Promise<void>;
  getHealth(options: { ownerUid: string }): Promise<{
    storageType: string;
    isDurable: boolean;
    unresolvedReceiptsCount: number;
    unresolvedCommandsCount: number;
    lastSuccessfulSync?: string;
    legacyMigrationPending?: boolean;
  }>;
  getPublicIdentity(): Promise<{
    fingerprint: string;
    publicKey: any;
    installationId: string;
  }>;
  signReceipt(options: { receipt: string }): Promise<{ signature: string }>;
  signDoctorQr(options: { claims: string }): Promise<{ signature: string }>;
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
  async initialize(): Promise<StorageHealth> {
    const res = await NativeAttendanceStorage.initialize();
    return {
      storageType: (res.storageType as any) || 'native_sqlite',
      isDurable: res.isDurable ?? true,
      unresolvedReceiptsCount: res.unresolvedReceiptsCount || 0,
      unresolvedCommandsCount: res.unresolvedCommandsCount || 0,
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

  async recoverInterruptedWork(): Promise<void> {
    await NativeAttendanceStorage.recoverInterruptedWork();
  }

  async getHealth(ownerUid: string): Promise<StorageHealth> {
    const res = await NativeAttendanceStorage.getHealth({ ownerUid });
    return {
      storageType: 'native_sqlite',
      isDurable: res.isDurable ?? true,
      unresolvedReceiptsCount: res.unresolvedReceiptsCount || 0,
      unresolvedCommandsCount: res.unresolvedCommandsCount || 0,
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

  async signReceipt(receipt: any): Promise<string> {
    const res = await NativeAttendanceStorage.signReceipt({
      receipt: JSON.stringify(receipt),
    });
    return res.signature;
  }

  async signDoctorQr(claims: any): Promise<string> {
    const res = await NativeAttendanceStorage.signDoctorQr({
      claims: JSON.stringify(claims),
    });
    return res.signature;
  }

  async signRotationMessage(message: string): Promise<string> {
    const res = await NativeAttendanceStorage.signRotationMessage({ message });
    return res.signature;
  }
}
