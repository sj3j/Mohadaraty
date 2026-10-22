import assert from 'node:assert/strict';
import { test } from 'node:test';
import QRCode from 'qrcode';
import {
  summarizeAttendanceTelemetry,
  attendanceScanTimeBadge,
  type AttendanceTelemetry,
} from '../shared/attendanceSecurity';

test('QR code with Level L and margin 1 produces cleaner and less dense SVG than Level M margin 4', async () => {
  const token = 'sample-jwt-attendance-token-for-simosan-lecturer-session';

  const svgLevelM = await QRCode.toString(token, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 4,
  });

  const svgLevelL = await QRCode.toString(token, {
    type: 'svg',
    errorCorrectionLevel: 'L',
    margin: 1,
  });

  assert.ok(svgLevelM.includes('<svg'));
  assert.ok(svgLevelL.includes('<svg'));
  // Level L should have fewer modules / path commands than Level M
  assert.ok(svgLevelL.length < svgLevelM.length, 'Level L SVG should be shorter/less complex than Level M');
});

test('summarizeAttendanceTelemetry preserves student scanTime and timezone in advisory', () => {
  const telemetry: AttendanceTelemetry = {
    location: {
      state: 'available',
      phase: 'scan',
      latitude: 33.3152,
      longitude: 44.3661,
      accuracyMeters: 15,
      distanceMeters: 10,
      locationStatus: 'on_campus',
    },
    scanTime: {
      capturedAt: '2026-10-22T10:30:00.000Z',
      timeZone: 'Asia/Baghdad',
      utcOffsetMinutes: 180,
      formattedLocalTime: '01:30:00 PM',
    },
  };

  const advisory = summarizeAttendanceTelemetry(telemetry);
  assert.ok(advisory.scanTime, 'Advisory should contain scanTime');
  assert.equal(advisory.scanTime.timeZone, 'Asia/Baghdad');
  assert.equal(advisory.scanTime.utcOffsetMinutes, 180);
  assert.equal(advisory.scanTime.capturedAt, '2026-10-22T10:30:00.000Z');
});

test('attendanceScanTimeBadge formats scan time and timezone clearly in Arabic and English', () => {
  const advisoryWithBaghdad = {
    flags: [],
    timingConfidence: 'unknown' as const,
    scanTime: {
      capturedAt: '2026-10-22T10:30:00.000Z',
      timeZone: 'Asia/Baghdad',
      utcOffsetMinutes: 180,
      formattedLocalTime: '01:30:00 م',
    },
  };

  const badgeAr = attendanceScanTimeBadge(advisoryWithBaghdad, true);
  const badgeEn = attendanceScanTimeBadge(advisoryWithBaghdad, false);

  assert.ok(badgeAr && badgeAr.includes('Asia/Baghdad'), 'Arabic badge should include timezone name');
  assert.ok(badgeAr.includes('GMT+3'), 'Arabic badge should show GMT offset');
  assert.ok(badgeEn && badgeEn.includes('Asia/Baghdad'), 'English badge should include timezone name');
  assert.ok(badgeEn.includes('GMT+3'), 'English badge should show GMT offset');
});

test('summarizeAttendanceTelemetry ignores invalid scanTime payloads safely', () => {
  const invalidTelemetry = {
    scanTime: {
      capturedAt: 12345, // invalid type
      timeZone: null,
    },
  };

  const advisory = summarizeAttendanceTelemetry(invalidTelemetry);
  assert.equal(advisory.scanTime, undefined);
});
