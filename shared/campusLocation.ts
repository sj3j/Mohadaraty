export const AL_SAFWA_CAMPUS = {
  lat: 32.623889,
  lng: 44.006667,
  radiusMeters: 450,
} as const;

export type CampusCoordinateStatus = 'on_campus' | 'off_campus';

export interface CampusDistanceResult {
  distanceMeters: number;
  accuracyMeters: number;
  locationStatus: CampusCoordinateStatus;
}

export function calculateCampusDistance(lat: number, lng: number, accuracyMeters = 0): CampusDistanceResult {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracyMeters)
    || Math.abs(lat) > 90 || Math.abs(lng) > 180 || accuracyMeters < 0) {
    throw new RangeError('invalid_campus_coordinates');
  }

  const R = 6371e3;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat - AL_SAFWA_CAMPUS.lat);
  const dLng = toRad(lng - AL_SAFWA_CAMPUS.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(AL_SAFWA_CAMPUS.lat)) *
      Math.cos(toRad(lat)) *
      Math.sin(dLng / 2) ** 2;
  const rawDistanceMeters = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  const effectiveAllowance = AL_SAFWA_CAMPUS.radiusMeters + Math.min(accuracyMeters, 150);
  const isInsideCampus = rawDistanceMeters <= effectiveAllowance;

  return {
    distanceMeters: rawDistanceMeters,
    accuracyMeters: Math.round(accuracyMeters),
    locationStatus: isInsideCampus ? 'on_campus' : 'off_campus',
  };
}
