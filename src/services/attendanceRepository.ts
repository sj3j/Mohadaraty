import type { LocalAttendanceReceipt } from '../../shared/attendance';

export interface StorageHealth {
  storageType: 'native_sqlite' | 'indexeddb';
  isDurable: boolean;
  unresolvedReceiptsCount: number;
  unresolvedCommandsCount: number;
  lastSuccessfulSync?: string;
  legacyMigrationPending?: boolean;
}

export interface CaptureInput {
  receipt: LocalAttendanceReceipt;
  conflictSignature?: string;
}

export interface DurableCaptureResult {
  receipt: LocalAttendanceReceipt;
  alreadySaved: boolean;
}

export interface DoctorSessionCommit {
  meta: { key: string; data: unknown };
  command: { requestId: string; ownerUid: string; [key: string]: unknown };
}

export interface DoctorCommand {
  requestId: string;
  ownerUid: string;
  sessionId?: string;
  input?: Record<string, unknown>;
  localOrder?: number;
  status?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface UploadBatch {
  receipts: LocalAttendanceReceipt[];
  leaseId: string;
}

export interface PublicDeviceIdentity {
  fingerprint: string;
  publicKey: JsonWebKey;
  installationId: string;
  legacyKeyAvailable?: boolean;
}

export interface AttendanceRepository {
  initialize(): Promise<StorageHealth>;
  capture(input: CaptureInput): Promise<DurableCaptureResult>;
  listReceipts(ownerUid: string): Promise<LocalAttendanceReceipt[]>;
  getReceipt(requestId: string): Promise<LocalAttendanceReceipt | null>;
  commitDoctorSession(input: DoctorSessionCommit): Promise<void>;
  enqueueDoctorCommand(command: DoctorCommand): Promise<void>;
  listDoctorCommands(ownerUid: string): Promise<DoctorCommand[]>;
  updateDoctorCommand(command: DoctorCommand): Promise<void>;
  updateReceipt(requestId: string, update: (curr: LocalAttendanceReceipt) => LocalAttendanceReceipt): Promise<void>;
  recoverInterruptedWork(): Promise<void>;
  getHealth(ownerUid: string): Promise<StorageHealth>;
}

export interface AttendanceSigner {
  getPublicIdentity(): Promise<PublicDeviceIdentity>;
  signReceipt(receipt: any): Promise<string>;
  signDoctorQr(claims: any): Promise<string>;
  signRotationMessage(message: string): Promise<string>;
}
