import { Capacitor, registerPlugin } from '@capacitor/core';
import { Geolocation, type Position } from '@capacitor/geolocation';
import { calculateCampusDistance } from '../../shared/campusLocation';
import type { AttendanceScanLocationEvidence } from '../../shared/attendanceSecurity';

interface SettingsLauncherPlugin {
  isLocationServicesEnabled(): Promise<{ enabled: boolean }>;
  openAppSettings(): Promise<void>;
}

const SettingsLauncher = registerPlugin<SettingsLauncherPlugin>('SettingsLauncher');
type PermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';

export type AttendanceLocationGateFailure = 'permission_denied' | 'gps_disabled' | 'timeout' | 'unavailable';

export class AttendanceLocationGateError extends Error {
  constructor(readonly kind: AttendanceLocationGateFailure, readonly permissionState?: PermissionState) {
    super(kind);
  }
}

const POSITION_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 4500,
  maximumAge: 600000,
} as const;

function errorCode(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown } | undefined;
  return `${String(candidate?.code ?? '')} ${String(candidate?.message ?? '')}`.toUpperCase();
}

function isPermissionError(error: unknown): boolean {
  const code = errorCode(error);
  return code.includes('OS-PLUG-GLOC-0003') || code.includes('PERMISSION_DENIED')
    || (error as { code?: unknown } | undefined)?.code === 1;
}

function isGpsDisabledError(error: unknown): boolean {
  const code = errorCode(error);
  return ['OS-PLUG-GLOC-0007', 'OS-PLUG-GLOC-0009', 'OS-PLUG-GLOC-0017'].some(value => code.includes(value));
}

function isTimeoutError(error: unknown): boolean {
  const code = errorCode(error);
  return code.includes('OS-PLUG-GLOC-0010') || code.includes('TIMEOUT')
    || (error as { code?: unknown } | undefined)?.code === 3;
}

function toEvidence(position: Position | GeolocationPosition): AttendanceScanLocationEvidence {
  const summary = calculateCampusDistance(position.coords.latitude, position.coords.longitude, position.coords.accuracy);
  return {
    state: 'available',
    phase: 'scan',
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    ...summary,
  };
}

async function nativeLocationServicesEnabled(): Promise<boolean> {
  try {
    if (Capacitor.isPluginAvailable('SettingsLauncher')) {
      return (await SettingsLauncher.isLocationServicesEnabled()).enabled;
    }
    await Geolocation.checkPermissions();
    return true;
  } catch (error) {
    if (isGpsDisabledError(error)) return false;
    throw error;
  }
}

function permissionGranted(location: PermissionState, coarseLocation: PermissionState): boolean {
  return location === 'granted' || coarseLocation === 'granted';
}

async function ensureNativePermission(): Promise<void> {
  let status;
  try {
    status = await Geolocation.checkPermissions();
  } catch (error) {
    if (isGpsDisabledError(error)) throw new AttendanceLocationGateError('gps_disabled');
    if (isPermissionError(error)) throw new AttendanceLocationGateError('permission_denied', 'denied');
    throw new AttendanceLocationGateError('unavailable');
  }

  if (permissionGranted(status.location, status.coarseLocation)) return;
  if (status.location === 'denied' && status.coarseLocation === 'denied') {
    throw new AttendanceLocationGateError('permission_denied', 'denied');
  }

  try {
    const requested = await Geolocation.requestPermissions({ permissions: ['location', 'coarseLocation'] });
    if (!permissionGranted(requested.location, requested.coarseLocation)) {
      throw new AttendanceLocationGateError('permission_denied', requested.location);
    }
  } catch (error) {
    if (error instanceof AttendanceLocationGateError) throw error;
    if (isGpsDisabledError(error)) throw new AttendanceLocationGateError('gps_disabled');
    if (isPermissionError(error)) throw new AttendanceLocationGateError('permission_denied', 'denied');
    throw new AttendanceLocationGateError('unavailable');
  }
}

async function nativePrerequisitesRemainValid(): Promise<boolean> {
  try {
    if (!await nativeLocationServicesEnabled()) return false;
    const permission = await Geolocation.checkPermissions();
    return permissionGranted(permission.location, permission.coarseLocation);
  } catch {
    return false;
  }
}

async function verifyNativeLocation(): Promise<AttendanceScanLocationEvidence> {
  if (!await nativeLocationServicesEnabled()) throw new AttendanceLocationGateError('gps_disabled');
  await ensureNativePermission();
  try {
    return toEvidence(await Geolocation.getCurrentPosition(POSITION_OPTIONS));
  } catch (error) {
    if (isPermissionError(error)) throw new AttendanceLocationGateError('permission_denied', 'denied');
    if (isGpsDisabledError(error)) throw new AttendanceLocationGateError('gps_disabled');
    if (isTimeoutError(error)) {
      if (await nativePrerequisitesRemainValid()) {
        return { state: 'gps_on_indoor_timeout', phase: 'scan', locationStatus: 'gps_on_indoor_timeout' };
      }
      if (!await nativeLocationServicesEnabled().catch(() => false)) throw new AttendanceLocationGateError('gps_disabled');
      throw new AttendanceLocationGateError('permission_denied', 'denied');
    }
    // POSITION_UNAVAILABLE is deliberately not treated as proof that GPS is off.
    if (!await nativeLocationServicesEnabled().catch(() => false)) throw new AttendanceLocationGateError('gps_disabled');
    throw new AttendanceLocationGateError('unavailable');
  }
}

async function verifyWebLocation(): Promise<AttendanceScanLocationEvidence> {
  if (!navigator.geolocation) throw new AttendanceLocationGateError('unavailable');
  try {
    const permission = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    if (permission?.state === 'denied') throw new AttendanceLocationGateError('permission_denied', 'denied');
  } catch (error) {
    if (error instanceof AttendanceLocationGateError) throw error;
    // Browsers may not implement the Permissions API for geolocation; the position request remains authoritative.
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      position => {
        try { resolve(toEvidence(position)); }
        catch { reject(new AttendanceLocationGateError('unavailable')); }
      },
      error => {
        if (error.code === error.PERMISSION_DENIED) reject(new AttendanceLocationGateError('permission_denied', 'denied'));
        else if (error.code === error.TIMEOUT) reject(new AttendanceLocationGateError('timeout'));
        else reject(new AttendanceLocationGateError('unavailable'));
      },
      POSITION_OPTIONS,
    );
  });
}

export async function verifyAttendanceScanLocation(): Promise<AttendanceScanLocationEvidence> {
  return Capacitor.isNativePlatform() ? verifyNativeLocation() : verifyWebLocation();
}

export async function retryAttendanceGpsEnablement(): Promise<AttendanceScanLocationEvidence> {
  if (!Capacitor.isNativePlatform()) return verifyWebLocation();
  try {
    // On Android the official plugin invokes Google Play Services' resolvable
    // location-settings flow before attempting the position request.
    return toEvidence(await Geolocation.getCurrentPosition(POSITION_OPTIONS));
  } catch (error) {
    if (isPermissionError(error)) throw new AttendanceLocationGateError('permission_denied', 'denied');
    if (isGpsDisabledError(error)) throw new AttendanceLocationGateError('gps_disabled');
    if (isTimeoutError(error)) {
      if (await nativePrerequisitesRemainValid()) {
        return { state: 'gps_on_indoor_timeout', phase: 'scan', locationStatus: 'gps_on_indoor_timeout' };
      }
      if (!await nativeLocationServicesEnabled().catch(() => false)) throw new AttendanceLocationGateError('gps_disabled');
      throw new AttendanceLocationGateError('permission_denied', 'denied');
    }
    if (!await nativeLocationServicesEnabled().catch(() => false)) throw new AttendanceLocationGateError('gps_disabled');
    throw new AttendanceLocationGateError('unavailable');
  }
}

export async function resolveAttendancePermissionBlock(): Promise<'retry' | 'foreground'> {
  if (!Capacitor.isNativePlatform()) return 'retry';
  try {
    const status = await Geolocation.checkPermissions();
    if (status.location === 'prompt' || status.location === 'prompt-with-rationale'
      || status.coarseLocation === 'prompt' || status.coarseLocation === 'prompt-with-rationale') {
      await Geolocation.requestPermissions({ permissions: ['location', 'coarseLocation'] });
      return 'retry';
    }
  } catch (error) {
    if (isGpsDisabledError(error)) return 'retry';
  }
  if (Capacitor.isPluginAvailable('SettingsLauncher')) {
    await SettingsLauncher.openAppSettings();
    return 'foreground';
  }
  return 'retry';
}
