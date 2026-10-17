import { UserProfile } from '../types';
import {
  CONTENT_CAPABILITIES,
  REPRESENTATIVE_ONLY_CAPABILITIES,
  SYSTEM_CAPABILITIES as SHARED_SYSTEM_CAPABILITIES,
  SUBSCRIPTION_SUPPORT_CAPABILITIES as SHARED_SUBSCRIPTION_SUPPORT_CAPABILITIES,
  MASTER_ONLY_CAPABILITIES as SHARED_MASTER_ONLY_CAPABILITIES,
  SUPPORT_CAPABILITIES as SHARED_SUPPORT_CAPABILITIES,
  StaffCapability,
  hasStaffCapability,
} from '../../shared/staffCapabilities';

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
export const MODERATOR_CAPABILITIES = CONTENT_CAPABILITIES;

/** Never available to a moderator: both read the `students` whitelist, which
 *  holds emails, exam codes and password hashes. */
export const ADMIN_ONLY_CAPABILITIES = REPRESENTATIVE_ONLY_CAPABILITIES;

/**
 * Tools that act on every stage at once, so they are not one stage's business.
 *
 * manageSubscriptions belongs here and not with the per-stage capabilities: a
 * subscription is bought by an account, not by a stage, and the ledger has no
 * stageId to scope on. It is also the widest of the four - it reads every
 * student's payment history - so the `!== false` arm a representative gets
 * would be exactly wrong for it.
 *
 * Hard-denied to a representative and a moderator, grantable to support. The
 * denial is not decoration: a representative resolves an ABSENT key as granted
 * (`!== false`, for legacy docs that carry no permissions map), so without this
 * list, moving canManageStreakSystem off its isMasterAdmin alias would hand the
 * streak system to every representative in the college.
 */
export const SYSTEM_CAPABILITIES = SHARED_SYSTEM_CAPABILITIES;
export const SUBSCRIPTION_SUPPORT_CAPABILITIES = SHARED_SUBSCRIPTION_SUPPORT_CAPABILITIES;

/**
 * Never held by anyone but the master admin, whatever is stored.
 *
 *   viewAdminLogs        - the audit trail of every staff action, which is
 *                          where a support account's own actions are recorded.
 *   manageCalendar       - moves the academic year for all five stages at once,
 *                          and drives the season reset and progression.
 *   manageSimosanBilling - real dollars and the monthly ceiling.
 */
export const MASTER_ONLY_CAPABILITIES = SHARED_MASTER_ONLY_CAPABILITIES;

/** Everything a support account may be ticked for. */
export const SUPPORT_CAPABILITIES = SHARED_SUPPORT_CAPABILITIES;

export type Capability = StaffCapability;

export const isMasterAdmin = (user?: UserProfile | null): boolean =>
  !!user?.isMasterAdmin;

export const isObserver = (user?: UserProfile | null): boolean =>
  user?.role === 'observer';

/** A stage representative. */
export const isRepresentative = (user?: UserProfile | null): boolean =>
  user?.role === 'admin';

export const isModerator = (user?: UserProfile | null): boolean =>
  user?.role === 'moderator';

export const isDoctor = (user?: UserProfile | null): boolean =>
  user?.role === 'doctor';

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

export const isEnabledSupport = (user?: UserProfile | null): boolean =>
  isSupport(user) && user?.staffDisabled !== true;

/** Anyone with a back-office role. Use for "show the admin surface at all". */
export const isStaff = (user?: UserProfile | null): boolean =>
  isRepresentative(user) || isModerator(user) || isEnabledSupport(user) || isObserver(user);

/** Staff whose reach is not limited to a single stage, so the viewing-stage
 *  picker is theirs and effectiveStageId follows it. */
export const isCrossStage = (user?: UserProfile | null): boolean =>
  isMasterAdmin(user) || isEnabledSupport(user) || isObserver(user);

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
  return hasStaffCapability(user, capability);
}

/** إدارة الطلاب and السعيّات والدرجات. */
export const canManageStudents = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageStudents');

export const canManageGrades = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageGrades');

export const canManageLectures = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageLectures');

/** Group/subgroup structure for a stage. */
export const canManageGroups = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageGroups');

/** Parsing the stage's timetable image and publishing the parsed week. Also
 *  checked server-side in /api/timetable/parse, which is the path that spends
 *  Gemini quota - firestore.rules scopes the two documents by stage only, the
 *  granularity every content collection has. */
export const canManageTimetable = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageTimetable');

export const canManageAttendance = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageAttendance');

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


/** System-wide surfaces. Master admin always; support when ticked. */
export const canManageStreakSystem = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageStreakSystem');

export const canManageMcqSystem = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageMcqSystem');

export const canManageAntiCheat = (user?: UserProfile | null): boolean =>
  canManage(user, 'manageAntiCheat');

/** Read-only observers may inspect the inbox; other staff need a capability
 * matching one of the alert-producing surfaces. */
export const canViewStaffInbox = (user?: UserProfile | null): boolean =>
  isObserver(user)
  || canManage(user, 'manageLectures')
  || canManage(user, 'manageStudents')
  || canManage(user, 'manageMcqSystem');


/** إدارة الاشتراكات. Master admin always; support when ticked. The screen is
 *  web-only either way - vite.config.ts stubs it for mode === 'native'. */
export const canManageSubscriptions = (user?: UserProfile | null): boolean =>
  isMasterAdmin(user)
  || canManage(user, 'canActivate')
  || canManage(user, 'canViewHistory')
  || canManage(user, 'canViewOwnBalance')
  || canManage(user, 'canViewExpiring');

export const canActivateSubscription = (user?: UserProfile | null): boolean =>
  canManage(user, 'canActivate');
export const canViewSubscriptionHistory = (user?: UserProfile | null): boolean =>
  canManage(user, 'canViewHistory');
export const canViewOwnSupportBalance = (user?: UserProfile | null): boolean =>
  canManage(user, 'canViewOwnBalance');
export const canViewExpiringSubscriptions = (user?: UserProfile | null): boolean =>
  canManage(user, 'canViewExpiring');
export const canGrantSubscription = (user?: UserProfile | null): boolean =>
  canManage(user, 'canGrant');
export const canSettleSupportBalances = (user?: UserProfile | null): boolean =>
  canManage(user, 'canSettle');
export const canVoidSubscription = (user?: UserProfile | null): boolean =>
  canManage(user, 'canVoid');
export const canViewAllSupportBalances = (user?: UserProfile | null): boolean =>
  canManage(user, 'canViewAllBalances');
export const canViewSubscriptionReports = (user?: UserProfile | null): boolean =>
  canManage(user, 'canViewReports');
export const canManageSupportStatus = (user?: UserProfile | null): boolean =>
  canManage(user, 'canManageSupportStatus');

/** Master-admin-exclusive. Deliberately left as aliases rather than routed
 *  through canManage, so there is no stored key that could ever turn them on. */
export const canViewAdminLogs = (user?: UserProfile | null) => canManage(user, 'viewAdminLogs');
export const canManageCalendar = isMasterAdmin;
export const canManageSimosanBilling = isMasterAdmin;
export const canManageTelegramMirror = isMasterAdmin;
