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
import { IS_MACOS_BUILD } from '../lib/platform';
import { callMacBridge } from '../macos/macBridge';

export const MIGRATION_CHECKPOINT_KEY = 'attendance_native_migration_checkpoint_v1';

export interface MigrationResult {
  migrated: boolean;
  skipped: boolean;
  receiptsCount: number;
  locksCount: number;
  commandsCount: number;
  metaCount: number;
}

let initBarrierPromise: Promise<void> | null = null;

/**
 * Single attendance initialization and migration barrier.
 * Every attendance read, capture, mutation, and upload awaits this barrier.
 */
export async function ensureAttendanceInitialized(): Promise<void> {
  if (!initBarrierPromise) {
    initBarrierPromise = (async () => {
        if (IS_MACOS_BUILD) {
          const health = await callMacBridge<any>('attendance', 'initialize', { ownerUid: '' });
          if (!health?.isDurable || health.healthState !== 'ready') {
            throw new Error(`attendance_storage_${health?.healthState || 'unavailable'}`);
          }
          return;
        }
        if (!Capacitor.isNativePlatform()) {
          return;
        }
        if (!Capacitor.isPluginAvailable('AttendanceStorage')) throw new Error('attendance_storage_unavailable');

        // Check authoritative native storage health first
        const health = await NativeAttendanceStorage.initialize();
        if (!health?.isDurable || !['ready', 'migration_required'].includes(health.healthState || '')) {
          throw new Error(`attendance_storage_${health?.healthState || 'unavailable'}`);
        }
        if (health && health.legacyMigrationPending === false) {
          // Native migration is already recorded in the SQLite migration journal
          return;
        }

        const migration = await runLosslessAttendanceMigration();
        if (!migration.migrated) throw new Error('attendance_migration_incomplete');
    })().catch(error => {
      // A transient locked key / failed transaction must be retried, never cached as success.
      initBarrierPromise = null;
      throw error;
    });
  }
  return initBarrierPromise;
}

export async function runLosslessAttendanceMigration(): Promise<MigrationResult> {
  if (IS_MACOS_BUILD) {
    const health = await callMacBridge<any>('attendance', 'initialize', { ownerUid: '' });
    if (!health?.isDurable || health.healthState !== 'ready') {
      throw new Error(`attendance_storage_${health?.healthState || 'unavailable'}`);
    }
    // A native Mac app has no predecessor IndexedDB container to import. The
    // encrypted SQLite store is authoritative from its first launch.
    return { migrated: true, skipped: false, receiptsCount: 0, locksCount: 0, commandsCount: 0, metaCount: 0 };
  }
  if (!Capacitor.isNativePlatform()) {
    return { migrated: false, skipped: true, receiptsCount: 0, locksCount: 0, commandsCount: 0, metaCount: 0 };
  }

  if (!isLocalDbAvailable()) {
    return { migrated: false, skipped: true, receiptsCount: 0, locksCount: 0, commandsCount: 0, metaCount: 0 };
  }

  try {
    const db = await openDb();
    
    // Inventory all legacy attendance data
    const receipts = db.objectStoreNames.contains(STORE_ATTENDANCE_OUTBOX)
      ? (await dbGetAll<any>(STORE_ATTENDANCE_OUTBOX)) || []
      : [];
      
    const locks = db.objectStoreNames.contains(STORE_ATTENDANCE_LOCKS)
      ? (await dbGetAll<any>(STORE_ATTENDANCE_LOCKS)) || []
      : [];
      
    const commands = db.objectStoreNames.contains(STORE_ATTENDANCE_COMMANDS)
      ? (await dbGetAll<any>(STORE_ATTENDANCE_COMMANDS)) || []
      : [];
      
    const meta = db.objectStoreNames.contains(STORE_META)
      ? (await dbGetAll<any>(STORE_META)) || []
      : [];

    // Filter metadata relevant to attendance (offline packs, doctor sessions, workspaces, etc.)
    const attendanceMeta = meta.filter(m => {
      if (!m || typeof m.key !== 'string') return false;
      const k = m.key;
      // CryptoKey is nonextractable and must stay in IndexedDB until rotation completes.
      return k !== 'attendance_installation_id' &&
        (k.startsWith('attendance') || k.startsWith('doctor') || k.includes('offline-pack'));
    });

    // Even if there are no receipts, if there are offline packs, commands, or locks,
    // we must migrate them to native authoritative storage.
    if (receipts.length === 0 && commands.length === 0 && locks.length === 0 && attendanceMeta.length === 0) {
      // Record empty migration in native journal so we don't scan IndexedDB again
      await NativeAttendanceStorage.migrateLegacyData({
        receipts: [],
        locks: [],
        commands: [],
        meta: [],
      });
      return { migrated: true, skipped: false, receiptsCount: 0, locksCount: 0, commandsCount: 0, metaCount: 0 };
    }

    const res = await NativeAttendanceStorage.migrateLegacyData({
      receipts: receipts.map(r => JSON.stringify(r)),
      locks: locks.map(l => JSON.stringify(l)),
      commands: commands.map(c => JSON.stringify(c)),
      meta: attendanceMeta.map(m => JSON.stringify(m)),
    });
    if (res.migratedCount !== receipts.length) throw new Error('attendance_migration_count_mismatch');

    return {
      migrated: true,
      skipped: false,
      receiptsCount: receipts.length,
      locksCount: locks.length,
      commandsCount: commands.length,
      metaCount: attendanceMeta.length,
    };
  } catch (error) {
    console.error('[attendanceMigration] Migration failed, preserving legacy IndexedDB data intact:', error);
    throw error;
  }
}
