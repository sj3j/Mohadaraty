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
import { IS_MACOS_BUILD } from '../lib/platform';
import { requireMacRuntime } from '../macos/macBridge';
import { MacAttendanceRepository, MacAttendanceSigner } from '../macos/macAttendanceRepository';

let repositoryInstance: AttendanceRepository | null = null;
let signerInstance: AttendanceSigner | null = null;

export function isNativeAttendanceAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AttendanceStorage');
}

export function getAttendanceRepository(): AttendanceRepository {
  if (IS_MACOS_BUILD) {
    requireMacRuntime();
    if (!repositoryInstance) repositoryInstance = new MacAttendanceRepository();
    return repositoryInstance;
  }
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
  if (IS_MACOS_BUILD) {
    requireMacRuntime();
    if (!signerInstance) signerInstance = new MacAttendanceSigner();
    return signerInstance;
  }
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
