# University Attendance System: Backend Agent Architecture & Frontend Plan

> **Authoritative Handover Guide**: This document establishes the exact separation of concerns, data contracts, and frontend expectations across the **three attendance tiers** so that the backend agent can wire up database logic, APIs, and auth credentials without mixing or compromising any tier.

---

## 1. System Architecture Matrix

| Tier | Primary User Role | Navigation Entry Point | Main Frontend Components | Core Backend Integration Points |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1: Management** | Master Admin (`role: 'admin'`) | Settings (`الإعدادات`) → Manage Attendance & Doctors | [`SettingsScreen.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/settings/SettingsScreen.tsx) (Line ~536) | Create Firebase Auth credentials, write to `users` collection with `role: 'doctor'`, `assignedStageId`, and `assignedSubjects`. |
| **Tier 2: Lecturers** | Doctor / Lecturer (`role: 'doctor'`) | Direct App Launch (Bypasses student shell via [`App.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/App.tsx#L1055)) | [`DoctorPortal.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/DoctorPortal.tsx), [`DoctorLiveSessionView.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/DoctorLiveSessionView.tsx), [`DoctorExcelTimetableView.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/DoctorExcelTimetableView.tsx), [`DoctorAnalyticsView.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/DoctorAnalyticsView.tsx), [`SubjectModeModal.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/SubjectModeModal.tsx) | Live hall QR session creation (`POST /api/attendance/sessions`), dynamic rotating QR tokens (~15s), batch updating student attendance cell states (`present`, `absent`, `excused`). |
| **Tier 3: Students** | Student (`role: 'student'`) | Services Hub (`الخدمات`) → Attendance (`الحضور`) | [`SimosanPage.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/simosan/SimosanPage.tsx), [`StudentSimosanView.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/simosan/StudentSimosanView.tsx), [`QrScannerModal.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/simosan/QrScannerModal.tsx) | Decode live camera QR, offline receipt generation (`LocalAttendanceReceipt` in IndexedDB), sync to `attendance_records`, fetch confirmed weeks timeline with substitution indicators. |

---

## 2. Tier 1: Management Screen (Admin & Provisioning)

### Frontend Boundary
- **Location**: [`src/components/settings/SettingsScreen.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/settings/SettingsScreen.tsx)
- **Visibility**: Exclusively rendered when `!IS_STORE_BUILD && isMasterAdmin(user)`.
- **Row**: `إدارة الحضور وحسابات التدريسيين` (Manage attendance & doctors).

### Backend Implementation Plan
1. **Modal Attachment**:
   - In `SettingsScreen.tsx`, attach a `DoctorAccountProvisionModal` to the `onClick` handler of the SettingsRow.
2. **Data Payload to Collect**:
   - `fullName`: Doctor's display name (e.g. `أ.د. حيدر كاظم`).
   - `email`: College institutional email (e.g. `haider.k@alsafwa.edu.iq`).
   - `password`: Strong initial password.
   - `assignedStageId`: Academic stage UUID/string (e.g. `stage_4`).
   - `assignedSubjects`: Array of **1 or 2 subjects maximum**:
     ```typescript
     interface AssignedSubject {
       id: string;          // e.g. "phar_401"
       nameAr: string;      // e.g. "علم الأدوية والسموم"
       nameEn: string;      // e.g. "Pharmacology & Toxicology"
       type: 'theoretical' | 'practical' | 'both';
     }
     ```
3. **Database Write**:
   - Provision account in Firebase Authentication: `createUserWithEmailAndPassword(auth, email, password)`.
   - Write user profile to Firestore `users/{uid}` and Supabase `users` table with:
     ```json
     {
       "uid": "...",
       "role": "doctor",
       "name": "أ.د. حيدر كاظم",
       "email": "haider.k@alsafwa.edu.iq",
       "assignedStageId": "stage_4",
       "assignedSubjects": [ ... ],
       "createdAt": "..."
     }
     ```
> [!CAUTION]
> **Strict Boundary Rule**: Management does **not** conduct attendance sessions or display spreadsheets. It is solely an administration portal for doctor account creation and subject assignment.

---

## 3. Tier 2: Lecturers / Doctor Screens (`role: 'doctor'`)

### Frontend Boundary
- **Location**: [`src/components/doctor/DoctorPortal.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/DoctorPortal.tsx)
- **Routing**: In [`src/App.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/App.tsx#L1055), when `user.role === 'doctor'`, all student screens, navigation tabs, and courses are bypassed directly into `<DoctorPortal />`.

### Three Core Sub-Screens
1. **Screen 1: Live QR Hall Session & Projector Display** ([`DoctorLiveSessionView.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/DoctorLiveSessionView.tsx))
   - **Projector View**: Large high-contrast QR display meant to be projected onto hall monitors.
   - **Dynamic Rotating Tokens**: Backend must generate time-sensitive tokens (~15–30 seconds validity) so students in WhatsApp groups cannot photograph and forward the code to absent peers.
   - **Live Roster Feed**: Real-time counter and attendee ticker showing verified student check-ins as they happen.
   - **Session Finalization**: Button to close the session, locking it against late scans.

2. **Screen 2: Excel-Like Master Timetable Spreadsheet** ([`DoctorExcelTimetableView.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/DoctorExcelTimetableView.tsx))
   - **Spreadsheet Grid**: Sticky right-to-left column for student names, academic codes, and groups.
   - **Interactive Cells**: Doctors can single-click any student's cell to toggle attendance status:
     - `present` (`✓` Present — Emerald)
     - `absent` (`✗` Absent — Rose)
     - `excused` (`⏱` Excused — Amber)
   - **Export**: Generates and downloads official college-compliant `.csv` / `.xlsx` sheets.
   - **Backend Sync**: Overrides must be persisted in batch to Supabase `attendance_records`.

3. **Screen 3: Analytics, Trends & Deprivation Warnings** ([`DoctorAnalyticsView.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/DoctorAnalyticsView.tsx))
   - **Iraqi Ministry 15% Absence Calibration**:
     - **Safe**: `< 5%` absence
     - **Alert**: `5% – 10%` absence
     - **First Warning (إنذار أول)**: `10% – 15%` absence
     - **Deprived (حرمان من الامتحان)**: `≥ 15%` absence
   - **Action**: Provides exportable lists of students nearing or reaching deprivation thresholds.

4. **Subject & Mode Switcher** ([`SubjectModeModal.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/SubjectModeModal.tsx))
   - Allows switching between the doctor's 1 or 2 assigned subjects.
   - Allows filtering by lecture mode (`theoretical`, `practical`, or `both`).

> [!WARNING]
> **Strict Boundary Rule**: Doctors only have authority over their assigned stage (`assignedStageId`) and assigned subjects (`assignedSubjects`). They cannot view or modify other lecturers' records.

---

## 4. Tier 3: Students Screen (Services Attendance Hub)

### Frontend Boundary
- **Location**: [`src/components/simosan/StudentSimosanView.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/simosan/StudentSimosanView.tsx)
- **Container**: Rendered inside [`SimosanPage.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/simosan/SimosanPage.tsx) when `user.role !== 'doctor'`.
- **Entry**: Bottom Nav → **الخدمات (Services)** → **الحضور (Attendance)**.

### Core Student Features & Backend Data Mapping
1. **Top Centered Scanner Action**:
   - Button: `تسجيل الحضور بقارئ الباركود` (emerald gradient button).
   - Opens [`QrScannerModal.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/simosan/QrScannerModal.tsx).
   - Backend logic:
     - Scanned QR string is passed to `captureAttendanceQr(value, user.uid)`.
     - Validates payload signature and timestamp.
     - Offline safety: Saves a cryptographically signed `LocalAttendanceReceipt` in IndexedDB.
     - Online upload: Triggers `syncAttendanceReceipts(user.uid)` to Supabase.

2. **Aesthetic Subject Cards (`StatCard` Style)**:
   - Rendered in a clean 2-column responsive layout matching the app's profile statistics tokens.
   - Displays:
     - Subject Arabic name & English subtitle
     - Doctor display name
     - Academic subject code (e.g. `PHAR-401`)
     - Overall attendance percentage badge

3. **Action Modal: نظري و عملي**:
   - Tapping any subject card opens this selection modal.
   - **نظري (Theoretical)**: Always available; displays enrolled theory lecture history.
   - **عملي (Practical)**: If `hasPractical === false`, this button is disabled with an informative badge: `غير متوفر - لا يوجد مختبر عملي لهذه المادة`.

4. **Weekly Attendance Breakdown with Substitution Tracking**:
   - Chronological academic weeks (`الأسبوع الأول`, `الأسبوع الثاني`, ...).
   - **Group Substitution Logic (Load-Bearing Requirement)**:
     - If student attended with their native group (`attendedGroup === user.group`, e.g. `D3`):
       - Badge: **`حاضر في كروبك (D3) ✓`** (Emerald).
     - If student made up a missed lecture in another group (`attendedGroup !== user.group`, e.g. `B2`):
       - Badge: **`تعويض في كروب (B2) ⚡`** (Violet/Indigo).
     - If missed:
       - Badge: **`غائب ✗`** (Rose).
     - If upcoming:
       - Badge: **`قادمة ⏱`** (Slate).
     - Shows exact date and Baghdad timestamp (e.g. `2026-10-04 • 11:00 ص`).

> [!IMPORTANT]
> **Strict Boundary Rule**: The student UI is strictly read-and-scan. Students can never manually alter their attendance state or create sessions.

---

## 5. Security & Device Binding Checklist for Backend Agent

1. **Hardware / Device Fingerprinting**:
   - Use the device policy defined in `supabase/migrations/20261015073458_attendance_device_policy.sql`.
   - Ensure a single student account cannot be used on multiple devices during the same lecture window to prevent proxy attendance ("تسجيل بديل").
2. **Rotating QR Anti-Tampering**:
   - The QR code on the doctor's projector must change every ~15–30 seconds.
   - Scanned receipts must include the cryptographic rotation hash; stale hashes must be rejected.
3. **Grace Period for Offline Sync**:
   - Allow students who scanned offline up to **36 hours** after the lecture end time to upload their receipt, as per university guidelines.
