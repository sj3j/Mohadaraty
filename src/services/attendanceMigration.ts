import { Capacitor } from '@capacitor/core';
import {
  openDb,
  dbGetAll,
  STORE_ATTENDANCE_OUTBOX,
  STORE_ATTENDANCE_LOCKS,
  STORE_ATTENDANCE_COMMANDS,
  STORE_META,
  isLocalDbAvailable,
} from '../lib/localDb';
import { NativeAttendanceStorage } from './nativeAttendanceRepository';
import { safeGetStorageItem, safeSetStorageItem } from '../hooks/useAuthWatchdog';

export const MIGRATION_CHECKPOINT_KEY = 'attendance_native_migration_checkpoint_v1';

export interface MigrationResult {
  migrated: boolean;
  skipped: boolean;
  receiptsCount: number;
  locksCount: number;
  commandsCount: number;
}

export async function runLosslessAttendanceMigration(): Promise<MigrationResult> {
  if (!Capacitor.isNativePlatform()) {
    return { migrated: false, skipped: true, receiptsCount: 0, locksCount: 0, commandsCount: 0 };
  }

  const checkpoint = safeGetStorageItem(MIGRATION_CHECKPOINT_KEY);
  if (checkpoint === 'completed') {
    return { migrated: false, skipped: true, receiptsCount: 0, locksCount: 0, commandsCount: 0 };
  }

  if (!isLocalDbAvailable()) {
    return { migrated: false, skipped: true, receiptsCount: 0, locksCount: 0, commandsCount: 0 };
  }

  try {
    const db = await openDb();
    const hasOutbox = db.objectStoreNames.contains(STORE_ATTENDANCE_OUTBOX);
    if (!hasOutbox) {
      safeSetStorageItem(MIGRATION_CHECKPOINT_KEY, 'completed');
      return { migrated: false, skipped: true, receiptsCount: 0, locksCount: 0, commandsCount: 0 };
    }

    const receipts = (await dbGetAll<any>(STORE_ATTENDANCE_OUTBOX)) || [];
    const locks = db.objectStoreNames.contains(STORE_ATTENDANCE_LOCKS)
      ? (await dbGetAll<any>(STORE_ATTENDANCE_LOCKS)) || []
      : [];
    const commands = db.objectStoreNames.contains(STORE_ATTENDANCE_COMMANDS)
      ? (await dbGetAll<any>(STORE_ATTENDANCE_COMMANDS)) || []
      : [];
    const meta = db.objectStoreNames.contains(STORE_META)
      ? (await dbGetAll<any>(STORE_META)) || []
      : [];

    const attendanceMeta = meta.filter(
      m => typeof m.key === 'string' && (m.key.startsWith('attendance') || m.key.startsWith('doctor'))
    );

    if (receipts.length === 0 && commands.length === 0 && locks.length === 0) {
      safeSetStorageItem(MIGRATION_CHECKPOINT_KEY, 'completed');
      return { migrated: true, skipped: false, receiptsCount: 0, locksCount: 0, commandsCount: 0 };
    }

    await NativeAttendanceStorage.migrateLegacyData({
      receipts: receipts.map(r => JSON.stringify(r)),
      locks: locks.map(l => JSON.stringify(l)),
      commands: commands.map(c => JSON.stringify(c)),
      meta: attendanceMeta.map(m => JSON.stringify(m)),
    });

    safeSetStorageItem(MIGRATION_CHECKPOINT_KEY, 'completed');
    return {
      migrated: true,
      skipped: false,
      receiptsCount: receipts.length,
      locksCount: locks.length,
      commandsCount: commands.length,
    };
  } catch (error) {
    console.error('[attendanceMigration] Migration failed, preserving legacy IndexedDB data intact:', error);
    return { migrated: false, skipped: false, receiptsCount: 0, locksCount: 0, commandsCount: 0 };
  }
}
