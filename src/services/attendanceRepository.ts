import type { LocalAttendanceReceipt } from '../../shared/attendance';

export interface StorageHealth {
  storageType: 'native_sqlite' | 'indexeddb';
  isDurable: boolean;
  healthState?: 'ready' | 'migration_required' | 'key_unavailable' | 'corrupt' | 'unavailable';
  unresolvedReceiptsCount: number;
  unresolvedCommandsCount: number;
  unreadableRecordsCount?: number;
  oldestPendingAgeMs?: number;
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

export interface AcknowledgementItem {
  requestId: string;
  resolution: string;
  reason?: string;
  recordId?: string;
  recordRevision?: number;
  recordStatus?: 'confirmed' | 'voided' | null;
  receivedAt?: string | null;
}

export interface PublicDeviceIdentity {
  fingerprint: string;
  publicKey: JsonWebKey;
  installationId: string;
  legacyKeyAvailable?: boolean;
}

export interface AttendanceRepository {
  initialize(ownerUid?: string): Promise<StorageHealth>;
  capture(input: CaptureInput): Promise<DurableCaptureResult>;
  listReceipts(ownerUid: string): Promise<LocalAttendanceReceipt[]>;
  getReceipt(requestId: string): Promise<LocalAttendanceReceipt | null>;
  commitDoctorSession(input: DoctorSessionCommit): Promise<void>;
  enqueueDoctorCommand(command: DoctorCommand): Promise<void>;
  listDoctorCommands(ownerUid: string): Promise<DoctorCommand[]>;
  updateDoctorCommand(command: DoctorCommand): Promise<void>;
  updateReceipt(requestId: string, update: (curr: LocalAttendanceReceipt) => LocalAttendanceReceipt): Promise<void>;
  transitionReceipt(
    requestId: string,
    status: string,
    options?: { resolution?: string; reason?: string; recordRevision?: number }
  ): Promise<LocalAttendanceReceipt | null>;
  acquireUploadLease(ownerUid: string, limit?: number, leaseDurationMs?: number): Promise<UploadBatch>;
  acknowledgeBatch(leaseId: string, acknowledgements: AcknowledgementItem[]): Promise<void>;
  releaseUploadLease(leaseId: string): Promise<void>;
  getMetadata<T = any>(key: string, ownerUid?: string): Promise<T | null>;
  setMetadata<T = any>(key: string, data: T, ownerUid?: string): Promise<void>;
  deleteMetadata(key: string, ownerUid?: string): Promise<void>;
  recoverInterruptedWork(): Promise<void>;
  getHealth(ownerUid: string): Promise<StorageHealth>;
}

export interface AttendanceSigner {
  getPublicIdentity(): Promise<PublicDeviceIdentity>;
  signReceipt(receipt: any, message?: string): Promise<string>;
  signDoctorQr(claimsOrParams: any): Promise<string>;
  signRotationMessage(message: string): Promise<string>;
}
