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
} from '../services/attendanceRepository';
import { callMacBridge } from './macBridge';

const attendanceCall = <T>(method: string, payload: unknown = {}) =>
  callMacBridge<T>('attendance', method, payload);

export class MacAttendanceRepository implements AttendanceRepository {
  initialize(ownerUid = ''): Promise<StorageHealth> {
    return attendanceCall('initialize', { ownerUid });
  }

  capture(input: CaptureInput): Promise<DurableCaptureResult> {
    return attendanceCall('capture', input);
  }

  listReceipts(ownerUid: string): Promise<LocalAttendanceReceipt[]> {
    return attendanceCall('listReceipts', { ownerUid });
  }

  getReceipt(requestId: string): Promise<LocalAttendanceReceipt | null> {
    return attendanceCall('getReceipt', { requestId });
  }

  commitDoctorSession(input: DoctorSessionCommit): Promise<void> {
    return attendanceCall('commitDoctorSession', input);
  }

  enqueueDoctorCommand(command: DoctorCommand): Promise<void> {
    return attendanceCall('enqueueDoctorCommand', { command });
  }

  listDoctorCommands(ownerUid: string): Promise<DoctorCommand[]> {
    return attendanceCall('listDoctorCommands', { ownerUid });
  }

  updateDoctorCommand(command: DoctorCommand): Promise<void> {
    return attendanceCall('updateDoctorCommand', { command });
  }

  async updateReceipt(requestId: string, update: (curr: LocalAttendanceReceipt) => LocalAttendanceReceipt): Promise<void> {
    const current = await this.getReceipt(requestId);
    if (!current) return;
    await attendanceCall('updateReceipt', { requestId, receipt: update(current) });
  }

  transitionReceipt(
    requestId: string,
    status: string,
    options: { resolution?: string; reason?: string; recordRevision?: number } = {},
  ): Promise<LocalAttendanceReceipt | null> {
    return attendanceCall('transitionReceipt', { requestId, status, ...options });
  }

  acquireUploadLease(ownerUid: string, limit = 25, leaseDurationMs = 120_000): Promise<UploadBatch> {
    return attendanceCall('acquireUploadLease', { ownerUid, limit, leaseDurationMs });
  }

  acknowledgeBatch(leaseId: string, acknowledgements: AcknowledgementItem[]): Promise<void> {
    return attendanceCall('acknowledgeBatch', { leaseId, acknowledgements });
  }

  releaseUploadLease(leaseId: string): Promise<void> {
    return attendanceCall('releaseUploadLease', { leaseId });
  }

  getMetadata<T = any>(key: string, ownerUid?: string): Promise<T | null> {
    return attendanceCall('getMetadata', { key, ownerUid });
  }

  setMetadata<T = any>(key: string, data: T, ownerUid?: string): Promise<void> {
    return attendanceCall('setMetadata', { key, data, ownerUid });
  }

  deleteMetadata(key: string, ownerUid?: string): Promise<void> {
    return attendanceCall('deleteMetadata', { key, ownerUid });
  }

  recoverInterruptedWork(): Promise<void> {
    return attendanceCall('recoverInterruptedWork');
  }

  getHealth(ownerUid: string): Promise<StorageHealth> {
    return attendanceCall('getHealth', { ownerUid });
  }
}

export class MacAttendanceSigner implements AttendanceSigner {
  getPublicIdentity(): Promise<PublicDeviceIdentity> {
    return attendanceCall('getPublicIdentity');
  }

  signReceipt(receipt: any, message?: string): Promise<string> {
    return attendanceCall<{ signature: string }>('signReceipt', {
      receipt,
      message: message || attendanceDeviceMessage(receipt),
    }).then(result => result.signature);
  }

  signDoctorQr(claimsOrParams: any): Promise<string> {
    return attendanceCall<{ signature: string }>('signDoctorQr', claimsOrParams)
      .then(result => result.signature);
  }

  signRotationMessage(message: string): Promise<string> {
    return attendanceCall<{ signature: string }>('signRotationMessage', { message })
      .then(result => result.signature);
  }
}

