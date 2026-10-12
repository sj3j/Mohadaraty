export const CONTENT_CAPABILITIES = [
  'manageLectures',
  'manageAnnouncements',
  'manageRecords',
  'manageHomeworks',
  'manageTimetable',
] as const;

export const REPRESENTATIVE_ONLY_CAPABILITIES = [
  'manageStudents',
  'manageGrades',
] as const;

export const SYSTEM_CAPABILITIES = [
  'manageStreakSystem',
  'manageMcqSystem',
  'manageAntiCheat',
  'manageSubscriptions',
] as const;

export const MASTER_ONLY_CAPABILITIES = [
  'viewAdminLogs',
  'manageCalendar',
  'manageSimosanBilling',
] as const;

export const SUPPORT_CAPABILITIES = [
  ...CONTENT_CAPABILITIES,
  ...REPRESENTATIVE_ONLY_CAPABILITIES,
  ...SYSTEM_CAPABILITIES,
  'manageAdmins',
  'manageGroups',
] as const;

export type StaffCapability =
  | typeof CONTENT_CAPABILITIES[number]
  | typeof REPRESENTATIVE_ONLY_CAPABILITIES[number]
  | typeof SYSTEM_CAPABILITIES[number]
  | typeof MASTER_ONLY_CAPABILITIES[number]
  | 'manageAdmins'
  | 'manageGroups';

export type StaffProjection = {
  role?: string | null;
  isMasterAdmin?: boolean;
  managedStageId?: string | null;
  permissions?: Record<string, boolean | undefined> | null;
};

const includes = (values: readonly string[], capability: StaffCapability) =>
  values.includes(capability);

/** Pure capability matrix shared by browser and both API entrypoints. */
export function hasStaffCapability(
  staff: StaffProjection | null | undefined,
  capability: StaffCapability,
): boolean {
  if (!staff) return false;
  if (staff.isMasterAdmin === true || staff.role === 'master_admin') return true;
  if (staff.role === 'observer' || includes(MASTER_ONLY_CAPABILITIES, capability)) return false;

  if (staff.role === 'support') {
    return includes(SUPPORT_CAPABILITIES, capability)
      && staff.permissions?.[capability] === true;
  }
  if (staff.role === 'admin') {
    if (includes(SYSTEM_CAPABILITIES, capability)) return false;
    return staff.permissions?.[capability] !== false;
  }
  if (staff.role === 'moderator') {
    return includes(CONTENT_CAPABILITIES, capability)
      && staff.permissions?.[capability] === true;
  }
  return false;
}

export function hasStageCapability(
  staff: StaffProjection | null | undefined,
  capability: StaffCapability,
  stageId: string | null | undefined,
): boolean {
  if (!staff || !stageId || !hasStaffCapability(staff, capability)) return false;
  if (staff.isMasterAdmin === true || staff.role === 'master_admin' || staff.role === 'support') return true;
  return (staff.role === 'admin' || staff.role === 'moderator')
    && !!staff.managedStageId
    && staff.managedStageId === stageId;
}
