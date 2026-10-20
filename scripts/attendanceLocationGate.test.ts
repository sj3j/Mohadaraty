import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AL_SAFWA_CAMPUS } from '../shared/campusLocation';
import { AttendanceLocationGateError, verifyAttendanceScanLocation } from '../src/services/attendanceLocationGate';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function installNavigator(value: Record<string, unknown>) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value });
}

test('web permission denial blocks before requesting coordinates', async () => {
  let requested = false;
  installNavigator({
    permissions: { query: async () => ({ state: 'denied' }) },
    geolocation: { getCurrentPosition: () => { requested = true; } },
  });
  await assert.rejects(verifyAttendanceScanLocation(), (error: unknown) =>
    error instanceof AttendanceLocationGateError && error.kind === 'permission_denied');
  assert.equal(requested, false);
});

test('web timeout stays blocked', async () => {
  installNavigator({
    permissions: { query: async () => ({ state: 'granted' }) },
    geolocation: {
      getCurrentPosition: (_success: unknown, failure: (error: any) => void) => failure({ code: 3, TIMEOUT: 3, PERMISSION_DENIED: 1 }),
    },
  });
  await assert.rejects(verifyAttendanceScanLocation(), (error: unknown) =>
    error instanceof AttendanceLocationGateError && error.kind === 'timeout');
});

test('web coordinate result uses the required request options and campus summary', async () => {
  let options: PositionOptions | undefined;
  installNavigator({
    permissions: { query: async () => ({ state: 'granted' }) },
    geolocation: {
      getCurrentPosition: (success: (position: GeolocationPosition) => void, _failure: unknown, nextOptions: PositionOptions) => {
        options = nextOptions;
        success({ coords: { latitude: AL_SAFWA_CAMPUS.lat, longitude: AL_SAFWA_CAMPUS.lng, accuracy: 12 } } as GeolocationPosition);
      },
    },
  });
  const evidence = await verifyAttendanceScanLocation();
  assert.deepEqual(options, { enableHighAccuracy: true, timeout: 4500, maximumAge: 600000 });
  assert.equal(evidence.state, 'available');
  assert.equal(evidence.locationStatus, 'on_campus');
  if (evidence.state === 'available') {
    assert.equal(evidence.distanceMeters, 0);
    assert.equal(evidence.accuracyMeters, 12);
  }
});

test('generic POSITION_UNAVAILABLE is not classified as disabled GPS', async () => {
  installNavigator({
    permissions: { query: async () => ({ state: 'granted' }) },
    geolocation: {
      getCurrentPosition: (_success: unknown, failure: (error: any) => void) => failure({ code: 2, TIMEOUT: 3, PERMISSION_DENIED: 1 }),
    },
  });
  await assert.rejects(verifyAttendanceScanLocation(), (error: unknown) =>
    error instanceof AttendanceLocationGateError && error.kind === 'unavailable');
});

after(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete (globalThis as any).navigator;
});
