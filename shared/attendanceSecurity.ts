import { calculateCampusDistance, type CampusDistanceResult } from './campusLocation.js';

export const ATTENDANCE_DISCIPLINARY_BANNER = 'تحذير أمني: يخضع تسجيل الحضور للتدقيق التلقائي عبر إحداثيات الموقع الجغرافي والبصمة الزمنية المشفرة للجهاز. أي محاولة لتسجيل الحضور من خارج القاعة الدراسية أو التحايل على النظام تُعد مخالفة انضباطية جسيمة وتُعرّض صاحبها للمساءلات القانونية وعقوبة الفصل.';

export type AttendanceLocationStatus = CampusDistanceResult['locationStatus'] | 'gps_on_indoor_timeout';

export type AttendanceScanLocationEvidence =
  | ({ state: 'available'; phase: 'scan'; latitude: number; longitude: number } & CampusDistanceResult)
  | { state: 'gps_on_indoor_timeout'; phase: 'scan'; locationStatus: 'gps_on_indoor_timeout' };

export interface AttendanceScanTimeEvidence {
  capturedAt: string;
  timeZone: string;
  utcOffsetMinutes: number;
  formattedLocalTime?: string;
}

export interface AttendanceTelemetry {
  capturedOffline?: boolean;
  sameRuntimeElapsedSeconds?: number;
  scanTime?: AttendanceScanTimeEvidence;
  location?: AttendanceScanLocationEvidence | {
    state: 'not_requested' | 'permission_unavailable' | 'timeout' | 'unavailable';
    phase: 'scan';
    latitude?: number;
    longitude?: number;
    accuracyMeters?: number;
  };
}

export interface AttendanceAdvisory {
  flags: string[];
  timingConfidence: 'unknown' | 'untrusted_same_runtime';
  reportedDistanceMeters?: number;
  accuracyMeters?: number;
  locationStatus?: AttendanceLocationStatus;
  scanTime?: AttendanceScanTimeEvidence;
}

export function summarizeAttendanceTelemetry(raw: unknown): AttendanceAdvisory {
  const telemetry = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
  const duration = telemetry.sameRuntimeElapsedSeconds;
  const hasDuration = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= 604800;
  const result: AttendanceAdvisory = { flags: [], timingConfidence: hasDuration ? 'untrusted_same_runtime' : 'unknown' };
  if (telemetry.capturedOffline === true && hasDuration && duration < 300) result.flags.push('rapid_reconnect');

  if (telemetry.scanTime && typeof telemetry.scanTime === 'object') {
    const { capturedAt, timeZone, utcOffsetMinutes, formattedLocalTime } = telemetry.scanTime;
    if (typeof capturedAt === 'string' && typeof timeZone === 'string' && typeof utcOffsetMinutes === 'number' && Number.isFinite(utcOffsetMinutes)) {
      result.scanTime = {
        capturedAt,
        timeZone,
        utcOffsetMinutes,
        formattedLocalTime: typeof formattedLocalTime === 'string' ? formattedLocalTime : undefined,
      };
    }
  }

  const location = telemetry.location;
  if (!location || location.phase !== 'scan') return result;
  if (location.state === 'gps_on_indoor_timeout') {
    result.locationStatus = 'gps_on_indoor_timeout';
    return result;
  }
  if (location.state === 'permission_unavailable') result.flags.push('location_permission_unavailable');
  if (location.state === 'timeout' || location.state === 'unavailable') result.flags.push('location_unavailable');
  const { latitude, longitude, accuracyMeters } = location;
  if (location.state !== 'available' || ![latitude, longitude, accuracyMeters].every(value => typeof value === 'number' && Number.isFinite(value))
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracyMeters < 0 || accuracyMeters > 100000) return result;
  const summary = calculateCampusDistance(latitude, longitude, accuracyMeters);
  result.reportedDistanceMeters = summary.distanceMeters;
  result.accuracyMeters = summary.accuracyMeters;
  result.locationStatus = summary.locationStatus;
  if (summary.locationStatus === 'off_campus') result.flags.push('reported_off_campus');
  return result;
}

export function attendanceLocationBadge(advisory: AttendanceAdvisory | undefined, arabic: boolean): string | null {
  if (!advisory?.locationStatus) return null;
  if (advisory.locationStatus === 'on_campus') return arabic ? '📍 داخل الكلية' : '📍 On campus';
  if (advisory.locationStatus === 'gps_on_indoor_timeout') {
    return arabic ? '📍 الموقع غير متاح — الإذن وخدمات الموقع مفعلة' : '📍 Location unavailable — permission and location services enabled';
  }
  if (typeof advisory.reportedDistanceMeters !== 'number' || !Number.isFinite(advisory.reportedDistanceMeters)) return null;
  const kilometres = (advisory.reportedDistanceMeters / 1000).toFixed(1);
  return arabic ? `⚠️ خارج الكلية (يبعد ${kilometres} كم)` : `⚠️ Off campus (${kilometres} km away)`;
}

export function attendanceScanTimeBadge(advisory: AttendanceAdvisory | undefined, arabic: boolean): string | null {
  const scanTime = advisory?.scanTime;
  if (!scanTime) return null;
  const timeStr = scanTime.formattedLocalTime || (scanTime.capturedAt ? new Date(scanTime.capturedAt).toLocaleTimeString(arabic ? 'ar-IQ' : 'en-GB', { timeZone: scanTime.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  const offsetHours = Math.round(scanTime.utcOffsetMinutes / 60);
  const sign = offsetHours >= 0 ? '+' : '';
  const gmtStr = `GMT${sign}${offsetHours}`;
  const tzName = scanTime.timeZone;
  if (arabic) {
    return `⏰ وقت المسح: ${timeStr} (${tzName} ${gmtStr})`;
  }
  return `⏰ Scan Time: ${timeStr} (${tzName} ${gmtStr})`;
}

export function attendanceDeviceMessage(receipt: {
  requestId: string; ownerUid: string; sessionId: string; occurrenceId: string; qrToken: string; installationId: string; localDeviceConflict?: boolean;
  deviceProofVersion?: number; locationProof?: AttendanceTelemetry['location'];
}): string {
  if (receipt.deviceProofVersion === 2) {
    return JSON.stringify(['MYLECTURE_ATTENDANCE_RECEIPT_V2', receipt.requestId, receipt.ownerUid,
      receipt.sessionId, receipt.occurrenceId, receipt.qrToken, receipt.installationId,
      receipt.localDeviceConflict === true, receipt.locationProof || null]);
  }
  return JSON.stringify([receipt.requestId, receipt.ownerUid, receipt.sessionId, receipt.occurrenceId, receipt.qrToken, receipt.installationId, receipt.localDeviceConflict === true]);
}

export function attendanceFlagLabel(flag: string, arabic: boolean): string {
  const labels: Record<string, [string, string]> = {
    shared_installation: ['محاولة استخدام الجهاز لطالبين — يلزم تسجيل يدوي للطالب الثاني', 'Shared device attempt — second student needs manual attendance'],
    device_session_conflict: ['الجهاز مستخدم لطالب آخر في هذه المحاضرة — يلزم تسجيل يدوي', 'Device used by another student in this lecture — manual attendance required'],
    device_enrollment_required: ['تحقق من هوية الطالب لاعتماد جهازه', 'Verify student ID to approve this device'],
    device_change_required: ['جهاز غير معتمد — تحقق من هوية الطالب', 'Unrecognized device — verify student ID'],
    device_unverified: ['تعذر التحقق من الجهاز — يلزم تسجيل يدوي', 'Device could not be verified — manual attendance required'],
    reported_off_campus: ['موقع مُبلّغ خارج الحرم — مؤشر غير قطعي', 'Reported off campus — unverified signal'],
    location_permission_unavailable: ['إذن الموقع غير متاح — ليس دليلاً على المخالفة', 'Location permission unavailable — not evidence of misconduct'],
    location_unavailable: ['تعذر تحديد الموقع', 'Location unavailable'],
    location_low_accuracy: ['دقة الموقع منخفضة', 'Low location accuracy'],
    rapid_reconnect: ['اتصال سريع بعد المسح دون إنترنت — مؤشر ضعيف', 'Rapid reconnect — low-confidence signal'],
    late_arrival: ['وصول متأخر (بعد الموعد النهائي) — يتطلب موافقة صريحة من الأستاذ', 'Late arrival (after deadline) — requires explicit doctor confirmation'],
    professor_reviewed: ['راجع الأستاذ الإثبات', 'Professor reviewed'],
    visiting_subgroup: ['طالب من مجموعة أخرى', 'Visiting subgroup'],
  };
  return labels[flag]?.[arabic ? 0 : 1] || flag;
}
