import { UserProfile } from '../types';

/**
 * Single source of truth for "who may do what".
 *
 * Replaces the inline `user?.role === 'admin' && user?.permissions?.x !== false`
 * pattern that was duplicated across a dozen components and drifted between them.
 *
 * Roles:
 *   master admin -> everything, on any stage (picks stage in Settings ->
 *                   Administration -> Viewing stage).
 *   support      -> cross-stage, and ticked capability by capability. Reaches
 *                   every stage the way the master admin does, minus the three
 *                   MASTER_ONLY_CAPABILITIES below. A support account promoted
 *                   from a representative KEEPS its managedStageId as a home
 *                   stage; that is presentational and must never limit it.
 *   admin        -> the stage representative. Everything for their own stage.
 *   moderator    -> an assistant appointed by a representative. Content only,
 *                   and only what the representative ticked.
 */

/** Permissions a moderator can be granted. Deliberately excludes anything that
 *  needs the `students` collection - see ADMIN_ONLY_CAPABILITIES. */
export const MODERATOR_CAPABILITIES = [
  'manageLectures',
  'manageAnnouncements',
  'manageRecords',
  'manageChat',
  'manageHomeworks',
] as const;

/** Never available to a moderator: both read the `students` whitelist, which
 *  holds emails, exam codes and password hashes. */
export const ADMIN_ONLY_CAPABILITIES = ['manageStudents', 'manageGrades'] as const;

/**
 * Tools that act on every stage at once, so they are not one stage's business.
 *
 * Hard-denied to a representative and a moderator, grantable to support. The
 * denial is not decoration: a representative resolves an ABSENT key as granted
 * (`!== false`, for legacy docs that carry no permissions map), so without this
 * list, moving canManageStreakSystem off its isMasterAdmin alias would hand the
 * streak system to every representative in the college.
 */
export const SYSTEM_CAPABILITIES = [
  'manageStreakSystem',
  'manageMcqSystem',
  'manageAntiCheat',
] as const;

/**
 * Never held by anyone but the master admin, whatever is stored.
 *
 *   viewAdminLogs        - the audit trail of every staff action, which is
 *                          where a support account's own actions are recorded.
 *   manageCalendar       - moves the academic year for all five stages at once,
 *                          and drives the season reset and progression.
 *   manageSimosanBilling - real dollars and the monthly ceiling.
 */
export const MASTER_ONLY_CAPABILITIES = [
  'viewAdminLogs',
  'manageCalendar',
  'manageSimosanBilling',
] as const;

/** Everything a support account may be ticked for. */
export const SUPPORT_CAPABILITIES = [
  ...MODERATOR_CAPABILITIES,
  ...ADMIN_ONLY_CAPABILITIES,
  ...SYSTEM_CAPABILITIES,
  'manageAdmins',
  'manageGroups',
] as const;

export type Capability =
  | typeof MODERATOR_CAPABILITIES[number]
  | typeof ADMIN_ONLY_CAPABILITIES[number]
  | typeof SYSTEM_CAPABILITIES[number]
  | typeof MASTER_ONLY_CAPABILITIES[number]
  | 'manageAdmins'
  | 'manageGroups';

const has = (list: readonly string[], capability: Capability): boolean =>
  list.includes(capability);

export const isMasterAdmin = (user?: UserProfile | null): boolean =>
  !!user?.isMasterAdmin;

/** A stage representative. */
export const isRepresentative = (user?: UserProfile | null): boolean =>
  user?.role === 'admin';

export const isModerator = (user?: UserProfile | null): boolean =>
  user?.role === 'moderator';

/**
 * A cross-stage support account.
 *
 * Note what this does NOT consult: managedStageId. A support account promoted
 * from a representative still carries one, and reading it as a scope would pin
 * them to the stage they used to represent - the exact bug the arm ordering in
 * StageContext and firestore.rules exists to avoid.
 */
export const isSupport = (user?: UserProfile | null): boolean =>
  user?.role === 'support';

/** Anyone with a back-office role. Use for "show the admin surface at all". */
export const isStaff = (user?: UserProfile | null): boolean =>
  isRepresentative(user) || isModerator(user) || isSupport(user);

/** Staff whose reach is not limited to a single stage, so the viewing-stage
 *  picker is theirs and effectiveStageId follows it. */
export const isCrossStage = (user?: UserProfile | null): boolean =>
  isMasterAdmin(user) || isSupport(user);

/**
 * Can this user perform `capability`?
 *
 * Master admin bypasses everything. A representative holds every capability
 * unless explicitly revoked (legacy docs have no permissions map, so absent
 * means allowed), except the system-wide and master-only ones. A moderator and
 * a support account must each be explicitly granted, and neither can hold a
 * capability its role is barred from regardless of what is stored on their doc.
 */
export function canManage(user: UserProfile | null | undefined, capability: Capability): boolean {
  if (!user) return false;
  if (isMasterAdmin(user)) return true;

  // Ahead of every role arm: nothing below the master admin reaches these, so
  // no stored map and no role can turn one on.
  if (has(MASTER_ONLY_CAPABILITIES, capability)) return false;

  // Support is tested BEFORE representative on purpose. A promoted
  // representative keeps its managedStageId, and isRepresentative would apply
  // "allowed unless false" to a map that was deliberately built as "denied
  // unless true" - silently granting everything the ticking left out.
  if (isSupport(user)) {
    return user.permissions?.[capability] === true;
  }

  if (isRepresentative(user)) {
    if (has(SYSTEM_CAPABILITIES, capability)) return false;
    return user.permissions?.[capability] !== false;
  }

  if (isModerator(user)) {
    if (has(ADMIN_ONLY_CAPABILITIES, capability)) return false;
    if (has(SYSTEM_CAPABILITIES, capability)) return false;
    return user.permissions?.[capability] === true;
  }

  return false;
}

/** إدارة الطلاب and السعيّات والدرجات. */
export const canManageStudents = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageStudents');

export const canManageGrades = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageGrades');

/** Group/subgroup structure for a stage. */
export const canManageGroups = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageGroups');

/** إدارة المساعدين. Master admin manages everyone; a representative may only
 *  appoint moderators inside their own stage; support may seat representatives
 *  and moderators but never another support account - see appointableRoles. */
export const canManageAssistants = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageAdmins');

/**
 * Which roles `user` may create or edit in إدارة المساعدين.
 *
 * The escalation guard. Support holds manageAdmins so it can seat and unseat
 * representatives, but a support account able to mint ANOTHER support - or a
 * master_admin - could grant itself the three master-only surfaces by proxy.
 * firestore.rules enforces the same list; this is only the UI half of it.
 */
export function appointableRoles(
  user?: UserProfile | null,
): readonly ('admin' | 'moderator' | 'support')[] {
  if (isMasterAdmin(user)) return ['admin', 'moderator', 'support'];
  if (!canManageAssistants(user)) return [];
  if (isSupport(user)) return ['admin', 'moderator'];
  if (isRepresentative(user)) return ['moderator'];
  return [];
}

export const canAppointRole = (
  user: UserProfile | null | undefined,
  role: 'admin' | 'moderator' | 'support',
): boolean => appointableRoles(user).includes(role);

/** System-wide surfaces. Master admin always; support when ticked. */
export const canManageStreakSystem = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageStreakSystem');

export const canManageMcqSystem = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageMcqSystem');

export const canManageAntiCheat = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageAntiCheat');

/** Master-admin-exclusive. Deliberately left as aliases rather than routed
 *  through canManage, so there is no stored key that could ever turn them on. */
export const canViewAdminLogs = isMasterAdmin;
export const canManageCalendar = isMasterAdmin;
export const canManageSimosanBilling = isMasterAdmin;
