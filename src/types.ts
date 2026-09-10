export type Category = 'pharmacology' | 'pharmacognosy' | 'organic_chemistry' | 'biochemistry' | 'cosmetics';
export type LectureType = 'theoretical' | 'practical';

// New Multi-Stage Types

/** Hard bounds on class structure. Groups run A..D, each with 1..4 subgroups (A1..D4). */
export const MAX_GROUPS = 4;
export const MAX_SUBGROUPS_PER_GROUP = 4;
export const GROUP_IDS = ['A', 'B', 'C', 'D'] as const;
export type GroupId = typeof GROUP_IDS[number];

export interface StageGroupConfig {
  groups: { id: GroupId; subgroupCount: number }[];
}

/** Used when a stage has no groupConfig yet, so behaviour matches the old hardcoded lists. */
export const DEFAULT_GROUP_CONFIG: StageGroupConfig = {
  groups: GROUP_IDS.map(id => ({ id, subgroupCount: MAX_SUBGROUPS_PER_GROUP })),
};

export interface Stage {
  id: string;
  nameEn: string;
  nameAr: string;
  order: number;
  representativeId?: string;
  groupConfig?: StageGroupConfig;
}

/**
 * Every stage runs two courses (كورس ١ / كورس ٢), each with its own subjects.
 * Deliberately NOT called "semester" - that word already means streak season in
 * this codebase (semesterArchives, StreakManagement.semesterName).
 */
export const COURSE_IDS = ['course_1', 'course_2'] as const;
export type CourseId = typeof COURSE_IDS[number];

export const COURSE_LABELS: Record<CourseId, { en: string; ar: string }> = {
  // Spelled out rather than numbered on purpose. 'كورس ١' ended in an
  // Arabic-Indic numeral and the tab renders a Latin subject count right after
  // it, so RTL ran the two together and the chip read 'كورس ١6'.
  course_1: { en: 'First Course', ar: 'الكورس الأول' },
  course_2: { en: 'Second Course', ar: 'الكورس الثاني' },
};

/** All existing content predates courses and belongs to Course II. */
export const DEFAULT_COURSE_ID: CourseId = 'course_2';

export interface Subject {
  id: string;          // slug, e.g. 'biochemistry_ii'
  stageId: string;
  courseId: CourseId;
  nameEn: string;
  nameAr: string;
  types: LectureType[];
  order: number;       // display order within the course
  isActive: boolean;
}

// Subscription types
export type SubscriptionPlan = 'monthly' | 'seasonal' | 'semi_annual';
export type SubscriptionStatus = 'active' | 'inactive' | 'pending' | 'cancelled';
export type PaymentMethod = 'zaincash' | 'superkey' | 'admin_grant';

export interface Subscription {
  id: string;
  userId: string;
  userEmail: string;
  userName?: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  startDate: any; // Firestore Timestamp
  endDate: any;   // Firestore Timestamp
  paymentMethod: PaymentMethod;
  transactionId?: string;
  amount: number; // in IQD
  createdAt: any;
  updatedAt?: any;
  approvedBy?: string;
  notes?: string;
}

export const PLAN_CONFIG: Record<SubscriptionPlan, { days: number; price: number; labelAr: string; labelEn: string }> = {
  monthly: { days: 30, price: 1000, labelAr: 'شهري', labelEn: 'Monthly' },
  seasonal: { days: 90, price: 3000, labelAr: 'فصلي', labelEn: 'Seasonal' },
  semi_annual: { days: 180, price: 5000, labelAr: 'نصف سنوي', labelEn: 'Semi-Annual' },
};

export interface LectureTab {
  id: string;
  name: string;
  lectureIds: string[];
  /** Owning stage. Absent on tabs created before tabs were split per stage;
   *  those still render for every stage. */
  stageId?: string;
}

export interface Lecture {
  id: string;
  title: string;
  /** Legacy taxonomy. Superseded by subjectId + courseId; absent on content
   *  uploaded against the real curriculum. */
  category?: Category;
  type: LectureType;
  description?: string;
  pdfUrl: string;
  youtubeUrl?: string;
  createdAt: any; // Firestore Timestamp
  uploadedBy: string;
  uploaderName?: string;
  number?: number;
  isWeekly?: boolean;
  version?: 'original' | 'translated';
  /** For a translated lecture, the document id of the original it was translated
   *  from. Set at upload. Makes the pair share one question bank: see
   *  bankLectureIdFor() in services/questionBankService.ts. Absent on originals,
   *  and on translated lectures uploaded before the field existed - those simply
   *  keep their own separate bank, which is the pre-existing behaviour. */
  translationOf?: string;
  stageId?: string;
  subjectId?: string;
  subjectName?: string;
  courseId?: CourseId;
}

export interface Post {
  id: string;
  content: string;
  createdAt: any;
  createdBy: string;
  authorName: string;
  authorPhotoUrl?: string;
  type?: 'text' | 'image' | 'video' | 'file';
  text?: string;
  date?: any;
  imageUrl?: string;
  videoUrl?: string;
  fileUrl?: string;
  fileName?: string;
  linkUrl?: string;
  linkTitle?: string;
  /** Owning stage. Announcements are stage-filtered in AnnouncementsScreen. */
  stageId?: string;
}

export interface RecordItem {
  id: string;
  title: string;
  /** Legacy taxonomy. See Lecture.category. */
  category?: Category;
  type: LectureType;
  description?: string;
  audioUrl: string;
  duration?: number; // Duration in seconds
  size?: number; // File size in MB
  createdAt: any;
  uploadedBy: string;
  uploaderName?: string;
  number?: number;
  stageId?: string;
  subjectId?: string;
  subjectName?: string;
  courseId?: CourseId;
}

export interface UserProfile {
  uid: string;
  name: string;
  originalName?: string;
  email: string;
  /**
   * 'admin' is the STAGE REPRESENTATIVE, not the master admin - the master
   * admin is identified by address (shared/masterAdmins.ts) and carries
   * role 'admin' too. 'support' is cross-stage: it acts on every stage rather
   * than the one in managedStageId, which for a promoted representative is
   * retained as a presentational home stage. See src/lib/permissions.ts.
   */
  role: 'admin' | 'moderator' | 'support' | 'student';
  isMasterAdmin?: boolean;
  photoUrl?: string;
  completedWeeklyTasks?: string[];
  favorites?: string[];
  studied?: string[];
  streakCount?: number;
  /** Peak of the CURRENT season only - startNewSeason zeroes this. */
  longestStreak?: number;
  /**
   * Peak across every season. Deliberately left out of the reset patch in
   * shared/seasonReset.ts so a student's record survives a rollover; without it
   * "الأطول" could never exceed the running season and read 0 every vacation.
   */
  bestStreakAllTime?: number;
  freezeTokens?: number;

  /**
   * Baghdad 'YYYY-MM-DD' of the last credited day; null after a season reset.
   * This is what record-activity actually writes. A `lastStreakDate` was declared
   * here and read by App.tsx for a long time, but no server code ever wrote it.
   */
  lastActiveDate?: string | null;
  examCode?: string;
  group?: string;
  notificationPreferences?: {
    lectures: boolean;
    announcements: boolean;
    chat?: boolean;
    records?: boolean;
    homeworks?: boolean;
  };
  /**
   * What was ticked in إدارة المساعدين. Keyed by Capability in
   * src/lib/permissions.ts, which is the only thing that should read it -
   * a bare `permissions?.x` lookup misses the per-role hard denials.
   *
   * A missing key does NOT mean the same thing for every role: a
   * representative holds a capability unless it is explicitly false (legacy
   * docs carry no map at all), while a moderator or a support account holds
   * nothing unless it is explicitly true.
   */
  permissions?: {
    manageLectures: boolean;
    manageAnnouncements: boolean;
    manageRecords: boolean;
    manageChat: boolean;
    manageHomeworks: boolean;
    manageStudents: boolean;
    manageGrades?: boolean;
    manageAdmins?: boolean;
    manageGroups?: boolean;
    // System-wide, granted to support only. A representative is hard-denied
    // these regardless of what is stored - `!== false` would otherwise hand
    // the streak system to every legacy doc that has no map.
    manageStreakSystem?: boolean;
    manageMcqSystem?: boolean;
    manageAntiCheat?: boolean;
    // Master-admin-only surfaces. Present so Capability is indexable against
    // this map; they are stripped on save and hard-denied on read, so a stored
    // `true` grants nothing.
    viewAdminLogs?: boolean;
    manageCalendar?: boolean;
    manageSimosanBilling?: boolean;
  };
  hasPendingStreakReset?: boolean;
  memberSince?: any;
  hideNameOnLeaderboard?: boolean;
  hidePhotoOnLeaderboard?: boolean;
  subgroup?: string;
  // Cached subscription fields
  isSubscribed?: boolean;
  subscriptionEnd?: any; // Firestore Timestamp
  subscriptionPlan?: SubscriptionPlan;
  
  // Multi-Stage & Progression fields
  stageId?: string;
  tahmeelSubjects?: string[];
  managedStageId?: string;
  hasCompletedProgression?: boolean;
  lastProgressionYear?: string;
  /** Calendar yearLabel of the last recorded progression answer. */
  progressionYear?: string;
  /** 'awaiting_resit' parks the student until the دور ثاني results are published. */
  progressionState?: 'awaiting_resit' | 'completed';
  /** Passed out of the final stage: read-only access, never asked again. */
  graduated?: boolean;
  /** Users this person has blocked. Applied on read; never hides their writes. */
  blockedUsers?: string[];
  /**
   * ISO date; while it is in the future the exam-code card stays hidden. The
   * only one of these three actually stored on the users document - a student
   * can write it themselves, which is the point.
   */
  examCodePromptSnoozedUntil?: string;
  /**
   * Merged in from students/{id} by App.tsx, not stored here. The students doc
   * is admin/server-write-only, which is what stops a student clearing their
   * own forced password change or inventing a linked Google address.
   */
  googleEmail?: string;
  mustChangePassword?: boolean;
}

export interface Student {
  id: string;
  name: string;
  email: string;
  password?: string; // Hashed password
  examCode: string;
  isActive: boolean;
  createdAt: any;
  currentName?: string; // Appended from users collection
  streakCount?: number;
  userUid?: string;
  baseStudentId?: string;
  isAuthAccountOnly?: boolean;
  hasMultiple?: boolean;
  group?: string;
  subgroup?: string;
  /** Set by every write path; the whitelist copy that syncUserStage reads on login. */
  stageId?: string;
  /**
   * normalizeName(name) - what name login queries. Written by every path that
   * writes `name`; a student without it can only sign in by email or code.
   */
  nameKey?: string;
  /** Short typeable alternative to a long Arabic name, e.g. "D4-01234". */
  loginCode?: string;
  /** loginCode uppercased - the field the login equality query actually hits. */
  loginCodeKey?: string;
  /**
   * True when `email` (and therefore the document id) is synthetic. The id is
   * still load-bearing - it is the auth uid - it is just not a mailbox, so the
   * UI shows the login code instead of showing it to anyone.
   */
  placeholderEmail?: boolean;
  /** Set on an imported generated password; cleared by POST /api/me/password. */
  mustChangePassword?: boolean;
  /**
   * A real Gmail the student linked from settings, proved by a verified Google
   * token. Google login falls back to querying this when the address is not
   * itself a document id. Never renames the document - see shared/rosterIdentity.
   */
  googleEmail?: string;
  googleLinkedAt?: any;
}

export interface Homework {
  id: string;
  subject: Category;
  type: LectureType | 'both';
  lectures: { label: string; lectureId: string }[];
  note?: string;
  createdAt: any;
  dueDate?: any;
  /** Owning stage. Every write path sets it; a homework without one is
   *  invisible to the stage-filtered query in WeeklyListScreen. */
  stageId?: string;
}

export type Language = 'ar' | 'en';

// Real-money strings live in their own module so the native build can drop
// them - see src/i18n/payments.ts. vite.config.ts aliases it to an empty stub
// for mode === 'native', which is what keeps the store bundle free of a
// purchase surface.
import { PAYMENT_STRINGS } from './i18n/payments';

export const TRANSLATIONS = {
  ar: {
    ...PAYMENT_STRINGS.ar,
    appName: 'محاضراتي',
    university: 'جامعة الصفوة',
    department: 'قسم الصيدلة',
    byFenix: 'بواسطة فينيكس',
    searchPlaceholder: 'البحث عن المحاضرات...',
    upload: 'رفع',
    adminPortal: 'بوابة المسؤول',
    allSubjects: 'جميع المواد',
    loading: 'جاري التحميل...',
    noLectures: 'لم يتم العثور على محاضرات',
    noLecturesDesc: 'لم نتمكن من العثور على أي محاضرات تطابق الفلاتر الحالية أو استعلام البحث.',
    view: 'عرض',
    download: 'تحميل',
    theoretical: 'نظري',
    practical: 'عملي',
    recently: 'مؤخراً',
    adminAccess: 'دخول المسؤول',
    enterPassword: 'أدخل كلمة المرور لإدارة المحاضرات',
    verifyPassword: 'تحقق من كلمة المرور',
    confirmIdentity: 'تأكيد الهوية عبر جوجل',
    passwordCorrect: 'كلمة المرور صحيحة! يرجى تسجيل الدخول بحساب جوجل المسؤول لتأكيد الهوية.',
    incorrectPassword: 'كلمة مرور غير صحيحة',
    publishLecture: 'نشر المحاضرة',
    uploading: 'جاري الرفع...',
    lectureTitle: 'عنوان المحاضرة',
    lectureNumber: 'رقم المحاضرة (اختياري)',
    pdfFile: 'ملف PDF',
    description: 'الوصف (اختياري)',
    category: 'المادة',
    type: 'النوع',
    clickToUpload: 'اضغط لرفع ملف PDF',
    maxSize: 'الحد الأقصى 10 ميجابايت',
    dragDrop: 'أو اسحب وأفلت الملف هنا',
    success: 'تم الرفع بنجاح!',
    uploadAnother: 'رفع محاضرة أخرى',
    close: 'إغلاق',
    errorNetwork: 'خطأ في الشبكة. يرجى التحقق من اتصالك بالإنترنت.',
    errorUnauthorized: 'ليس لديك صلاحية للقيام بهذا الإجراء.',
    errorQuota: 'تم تجاوز حصة التخزين. يرجى التواصل مع الدعم.',
    errorUnknown: 'حدث خطأ غير معروف أثناء الرفع.',
    allRights: 'جميع الحقوق محفوظة.',
    manageAdmins: 'إدارة المساعدين',
    username: 'اسم المستخدم',
    password: 'كلمة المرور',
    addAdmin: 'إضافة مساعد',
    adminList: 'قائمة المسؤولين',
    delete: 'حذف',
    subAdminLogin: 'دخول المسؤولين (اسم مستخدم)',
    login: 'تسجيل الدخول',
    invalidCredentials: 'اسم المستخدم أو كلمة المرور غير صحيحة',
    adminCreated: 'تم إنشاء المسؤول بنجاح',
    confirmDeleteAdmin: 'هل أنت متأكد من حذف هذا المسؤول؟',
    confirmDeleteLecture: 'هل أنت متأكد من حذف هذه المحاضرة؟ لا يمكن التراجع عن هذا الإجراء.',
    deleteLecture: 'حذف المحاضرة',
    editLecture: 'تعديل المحاضرة',
    saveChanges: 'حفظ التغييرات',
    editSuccess: 'تم التعديل بنجاح!',
    sortBy: 'ترتيب حسب',
    sortTitle: 'العنوان',
    sortDate: 'تاريخ الرفع',
    sortNumber: 'رقم المحاضرة',
    sortAsc: 'تصاعدي',
    sortDesc: 'تنازلي',
    pharmacyPortal: 'بوابة الصيدلة',
    resourceHub: 'محاضرات المرحلة الثالثة',
    pharmacology: 'فارما',
    pharmacognosy: ' عقاقير',
    organic_chemistry: 'عضوية',
    biochemistry: 'بايو',
    cosmetics: 'تكنو',
    navAnnouncements: 'تبليغات',
    navLectures: 'محاضرات',
    navWeekly: 'واجبات الأسبوع',
    navProfile: 'الملف الشخصي',
    navRecords: 'تسجيلات',
    navChat: 'الدردشة',
    original: 'أصلي',
    translated: 'مترجم',
    addToWeekly: 'إضافة لواجبات الأسبوع',
    createPost: 'إنشاء منشور',
    postContent: 'محتوى المنشور',
    publishPost: 'نشر',
    noPosts: 'لا توجد تبليغات حالياً',
    weeklyTasks: 'الواجبات',
    noWeeklyTasks: 'لا توجد واجبات لهذا الأسبوع',
    markCompleted: 'تحديد كمكتمل',
    completed: 'مكتمل',
    manageDownloads: 'إدارة المحاضرات المفضلة',
    offlineDownloads: 'محاضرات مفضلة',
    clearAll: 'مسح الكل',
    noDownloads: 'لا توجد محاضرات مفضلة',
    remove: 'إزالة',
    postHomework: 'إضافة واجب',
    editHomework: 'تعديل واجب',
    both: 'عملي ونظري',
    dueDate: 'تاريخ التسليم / الامتحان',
    examLectures: 'محاضرات الامتحان',
    addLecture: 'إضافة محاضرة',
    additionalNote: 'ملاحظة إضافية (اختياري)',
    examIncludes: 'الامتحان يتضمن:',
    confirmClearAll: 'هل أنت متأكد من مسح جميع المفضلة؟',
    confirmDeleteHomework: 'هل أنت متأكد من حذف هذا الواجب؟',
    studied: 'درستها',
    markStudied: 'تحديد كمدروسة',
    unmarkStudied: 'إلغاء التحديد',
    addToFavorites: 'إضافة للمفضلة',
    removeFromFavorites: 'إزالة من المفضلة',
    youtubeTag: 'شرح يوتيوب',
    // Subscription
    subscribNow: 'اشترك الآن',
    monthly: 'شهري',
    seasonal: 'فصلي',
    semiAnnual: 'نصف سنوي',
    days: 'يوم',
    bestValue: 'الأفضل قيمة',
    popular: 'الأكثر شيوعاً',
    pendingApproval: 'بانتظار الموافقة',
    daysRemaining: 'يوم متبقي',
    expiresOn: 'ينتهي في',
    renewSubscription: 'تجديد الاشتراك',
    transactionHistory: 'سجل المعاملات',
    noTransactions: 'لا توجد معاملات سابقة',
    // Access framing, used INSTEAD of the subscription strings in store builds.
    // Purchases happen entirely outside the app: a stage representative
    // activates an account. Saying "subscription" on a Play build invites a
    // reviewer to look for a purchase flow that must not exist there, and any
    // wording that points a user somewhere to pay is steering. These say only
    // what the account's state is and who changes it.
    accessStatus: 'حالة الوصول',
    accessActive: 'الوصول مفعّل',
    accessInactive: 'الوصول غير مفعّل',
    accessUntil: 'مفعّل حتى',
    accessManagedByRep: 'يتم تفعيل الوصول من قِبل ممثل مرحلتك.',
    accessFeatureLocked: 'هذه الميزة غير مفعّلة على حسابك.',
    activeSubscribers: 'المشتركون الفعالون',
    pendingPayments: 'مدفوعات معلقة',
    subscriberBreakdown: 'توزيع المشتركين',
    approve: 'موافقة',
    reject: 'رفض',
    extend: 'تمديد',
    cancel: 'إلغاء',
    grantSubscription: 'منح اشتراك',
    extendDays: 'عدد أيام التمديد',
    adminGrant: 'منحة إدارية',
  },
  en: {
    ...PAYMENT_STRINGS.en,
    appName: 'محاضراتي',
    university: 'ALSAFWA UNIVERSITY',
    department: 'Pharmacy Department',
    byFenix: 'By Fenix',
    searchPlaceholder: 'Search lectures...',
    upload: 'Upload',
    adminPortal: 'Admin Portal',
    allSubjects: 'All Subjects',
    loading: 'Loading lectures...',
    noLectures: 'No lectures found',
    noLecturesDesc: "We couldn't find any lectures matching your current filters or search query.",
    view: 'View',
    download: 'Download',
    theoretical: 'Theoretical',
    practical: 'Practical',
    recently: 'Recently',
    adminAccess: 'Admin Access',
    enterPassword: 'Enter password to manage lectures',
    verifyPassword: 'Verify Password',
    confirmIdentity: 'Confirm Identity with Google',
    passwordCorrect: 'Password correct! Please sign in with your Google Admin account to confirm identity.',
    incorrectPassword: 'Incorrect password',
    publishLecture: 'Publish Lecture',
    uploading: 'Uploading...',
    lectureTitle: 'Lecture Title',
    lectureNumber: 'Lecture Number (Optional)',
    pdfFile: 'PDF File',
    description: 'Description (Optional)',
    category: 'Category',
    type: 'Type',
    clickToUpload: 'Click to upload PDF file',
    maxSize: 'Max 10MB',
    dragDrop: 'or drag and drop file here',
    success: 'Upload Successful!',
    uploadAnother: 'Upload another lecture',
    close: 'Close',
    errorNetwork: 'Network error. Please check your internet connection.',
    errorUnauthorized: 'You do not have permission to perform this action.',
    errorQuota: 'Storage quota exceeded. Please contact support.',
    errorUnknown: 'An unknown error occurred during upload.',
    allRights: 'All rights reserved.',
    manageAdmins: 'Manage Assistants',
    username: 'Username',
    password: 'Password',
    addAdmin: 'Add Assistant',
    adminList: 'Admin List',
    delete: 'Delete',
    subAdminLogin: 'Admin Login (Username)',
    login: 'Login',
    invalidCredentials: 'Invalid username or password',
    adminCreated: 'Admin created successfully',
    confirmDeleteAdmin: 'Are you sure you want to delete this admin?',
    confirmDeleteLecture: 'Are you sure you want to delete this lecture? This action cannot be undone.',
    deleteLecture: 'Delete Lecture',
    editLecture: 'Edit Lecture',
    saveChanges: 'Save Changes',
    editSuccess: 'Changes saved successfully!',
    sortBy: 'Sort by',
    sortTitle: 'Title',
    sortDate: 'Upload Date',
    sortNumber: 'Lecture Number',
    sortAsc: 'Ascending',
    sortDesc: 'Descending',
    pharmacyPortal: 'Pharmacy Portal',
    resourceHub: 'Lecture Resource Hub',
    pharmacology: 'Pharmacology',
    pharmacognosy: 'Pharmacognosy',
    organic_chemistry: 'Organic Chemistry',
    biochemistry: 'Biochemistry',
    cosmetics: 'Cosmetics and Preparations',
    navAnnouncements: 'Announcements',
    navLectures: 'Lectures',
    navWeekly: 'Weekly List',
    navProfile: 'Profile',
    navRecords: 'Records',
    navChat: 'Chat',
    original: 'Original',
    translated: 'Translated',
    addToWeekly: 'Add to Weekly List',
    createPost: 'Create Post',
    postContent: 'Post Content',
    publishPost: 'Publish',
    noPosts: 'No announcements yet',
    weeklyTasks: 'Homework',
    noWeeklyTasks: 'No homework for this week',
    markCompleted: 'Mark Completed',
    completed: 'Completed',
    manageDownloads: 'Manage Favorites',
    offlineDownloads: 'Favorite Lectures',
    clearAll: 'Clear All',
    noDownloads: 'No favorites yet',
    remove: 'Remove',
    postHomework: 'Post Homework',
    editHomework: 'Edit Homework',
    both: 'Theo & Prac',
    dueDate: 'Due / Exam Date',
    examLectures: 'Exam Lectures',
    addLecture: 'Add Lecture',
    additionalNote: 'Additional Note (Optional)',
    examIncludes: 'Exam includes:',
    confirmClearAll: 'Are you sure you want to clear all favorites?',
    confirmDeleteHomework: 'Are you sure you want to delete this homework?',
    studied: 'Studied',
    markStudied: 'Mark as Studied',
    unmarkStudied: 'Unmark Studied',
    addToFavorites: 'Add to Favorites',
    removeFromFavorites: 'Remove from Favorites',
    youtubeTag: 'YouTube Video',
    // Subscription
    subscribNow: 'Subscribe Now',
    monthly: 'Monthly',
    seasonal: 'Seasonal',
    semiAnnual: 'Semi-Annual',
    days: 'days',
    bestValue: 'Best Value',
    popular: 'Popular',
    pendingApproval: 'Pending Approval',
    daysRemaining: 'days remaining',
    expiresOn: 'Expires on',
    renewSubscription: 'Renew Subscription',
    transactionHistory: 'Transaction History',
    noTransactions: 'No previous transactions',
    accessStatus: 'Access',
    accessActive: 'Access active',
    accessInactive: 'Access not active',
    accessUntil: 'Active until',
    accessManagedByRep: 'Access is activated by your stage representative.',
    accessFeatureLocked: 'This feature is not active on your account.',
    activeSubscribers: 'Active Subscribers',
    pendingPayments: 'Pending Payments',
    subscriberBreakdown: 'Subscriber Breakdown',
    approve: 'Approve',
    reject: 'Reject',
    extend: 'Extend',
    cancel: 'Cancel',
    grantSubscription: 'Grant Subscription',
    extendDays: 'Extension Days',
    adminGrant: 'Admin Grant',
  }
};

export const CATEGORIES: { value: Category; labelKey: keyof typeof TRANSLATIONS.en; types: LectureType[] }[] = [
  { value: 'pharmacology', labelKey: 'pharmacology', types: ['theoretical'] },
  { value: 'pharmacognosy', labelKey: 'pharmacognosy', types: ['theoretical', 'practical'] },
  { value: 'organic_chemistry', labelKey: 'organic_chemistry', types: ['theoretical', 'practical'] },
  { value: 'biochemistry', labelKey: 'biochemistry', types: ['theoretical', 'practical'] },
  { value: 'cosmetics', labelKey: 'cosmetics', types: ['theoretical', 'practical'] },
];
