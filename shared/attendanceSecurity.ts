export const ATTENDANCE_DISCIPLINARY_BANNER = 'تحذير أمني: يخضع تسجيل الحضور للتدقيق التلقائي عبر إحداثيات الموقع الجغرافي والبصمة الزمنية المشفرة للجهاز. أي محاولة لتسجيل الحضور من خارج القاعة الدراسية أو التحايل على النظام تُعد مخالفة انضباطية جسيمة وتُعرّض صاحبها للمساءلات القانونية وعقوبة الفصل.';

export interface AttendanceTelemetry {
  capturedOffline?: boolean;
  sameRuntimeElapsedSeconds?: number;
  location?: {
    state: 'not_requested' | 'available' | 'permission_unavailable' | 'timeout' | 'unavailable';
    phase: 'scan';
    latitude?: number;
    longitude?: number;
    accuracyMeters?: number;
  };
}

export interface CampusBoundary {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export interface AttendanceAdvisory {
  flags: string[];
  timingConfidence: 'unknown' | 'untrusted_same_runtime';
  reportedDistanceMeters?: number;
  accuracyMeters?: number;
}

export function summarizeAttendanceTelemetry(raw: unknown, campus?: CampusBoundary): AttendanceAdvisory {
  const telemetry = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
  const duration = telemetry.sameRuntimeElapsedSeconds;
  const hasDuration = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= 604800;
  const result: AttendanceAdvisory = { flags: [], timingConfidence: hasDuration ? 'untrusted_same_runtime' : 'unknown' };
  if (telemetry.capturedOffline === true && hasDuration && duration < 300) result.flags.push('rapid_reconnect');
  const location = telemetry.location;
  if (!location || location.phase !== 'scan') return result;
  if (location.state === 'permission_unavailable') result.flags.push('location_permission_unavailable');
  if (location.state === 'timeout' || location.state === 'unavailable') result.flags.push('location_unavailable');
  const { latitude, longitude, accuracyMeters } = location;
  if (location.state !== 'available' || ![latitude, longitude, accuracyMeters].every(value => typeof value === 'number' && Number.isFinite(value))
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracyMeters < 0 || accuracyMeters > 100000) return result;
  result.accuracyMeters = Math.round(accuracyMeters);
  if (!campus) return result;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const haversine = Math.sin(radians(latitude - campus.latitude) / 2) ** 2
    + Math.cos(radians(campus.latitude)) * Math.cos(radians(latitude)) * Math.sin(radians(longitude - campus.longitude) / 2) ** 2;
  const distance = 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
  result.reportedDistanceMeters = Math.round(distance / 100) * 100;
  if (accuracyMeters <= 200 && distance - accuracyMeters > campus.radiusMeters + 100) result.flags.push('reported_off_campus');
  else if (accuracyMeters > 200) result.flags.push('location_low_accuracy');
  return result;
}

export function attendanceDeviceMessage(receipt: {
  requestId: string; ownerUid: string; sessionId: string; occurrenceId: string; qrToken: string; installationId: string; localDeviceConflict?: boolean;
}): string {
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
    professor_reviewed: ['راجع الأستاذ الإثبات', 'Professor reviewed'],
    visiting_subgroup: ['طالب من مجموعة أخرى', 'Visiting subgroup'],
  };
  return labels[flag]?.[arabic ? 0 : 1] || flag;
}
