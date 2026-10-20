import { Capacitor } from '@capacitor/core';
import type { AttendanceRepository, AttendanceSigner } from './attendanceRepository';
import {
  IndexedDbAttendanceRepository,
  IndexedDbAttendanceSigner,
} from './indexedDbAttendanceRepository';
import {
  NativeAttendanceRepository,
  NativeAttendanceSigner,
} from './nativeAttendanceRepository';

let repositoryInstance: AttendanceRepository | null = null;
let signerInstance: AttendanceSigner | null = null;

export function isNativeAttendanceAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AttendanceStorage');
}

export function getAttendanceRepository(): AttendanceRepository {
  if (Capacitor.isNativePlatform() && !isNativeAttendanceAvailable()) throw new Error('attendance_storage_unavailable');
  if (repositoryInstance) return repositoryInstance;
  if (isNativeAttendanceAvailable()) {
    repositoryInstance = new NativeAttendanceRepository();
  } else {
    repositoryInstance = new IndexedDbAttendanceRepository();
  }
  return repositoryInstance;
}

export function getAttendanceSigner(): AttendanceSigner {
  if (Capacitor.isNativePlatform() && !isNativeAttendanceAvailable()) throw new Error('attendance_storage_unavailable');
  if (signerInstance) return signerInstance;
  if (isNativeAttendanceAvailable()) {
    signerInstance = new NativeAttendanceSigner();
  } else {
    signerInstance = new IndexedDbAttendanceSigner();
  }
  return signerInstance;
}

/** Reset instances (useful for testing or switching environments) */
export function resetAttendanceInstances(): void {
  repositoryInstance = null;
  signerInstance = null;
}
