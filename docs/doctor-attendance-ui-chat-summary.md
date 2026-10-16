# Campus Attendance System Architecture & UI Archive
**Date**: 2026-10-15  
**Topic**: Doctor Attendance System & Student Services Attendance Window (Live Cam QR Scanner)  
**Status**: Fully Completed (UI Layer, Zero DB Touching, TypeScript 0 errors, Verified in Browser)

---

## 1. System Overview

This project includes two complementary experiences for university lecture attendance:
1. **The Doctor Portal** (`role: 'doctor'`):
   - Opens directly upon doctor login, completely dropping standard student screens.
   - Master Admin provisions accounts from the Settings "Manage Attendance" row (left ready for backend agent).
   - Allows switching between assigned subjects (1 or 2) and lecture modes (Theoretical / Practical / Both).
   - Features 3 dedicated screens:
     - **Screen 1**: Live QR Hall Session & Projector Display ([`DoctorLiveSessionView.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/DoctorLiveSessionView.tsx)).
     - **Screen 2**: Excel-like Master Timetable spreadsheet with sticky student name column, cell toggling (`✓` Present, `✗` Absent, `⏱` Excused), and CSV export ([`DoctorExcelTimetableView.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/DoctorExcelTimetableView.tsx)).
     - **Screen 3**: Analytics, attendance trends, and deprivation warnings ([`DoctorAnalyticsView.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/doctor/DoctorAnalyticsView.tsx)).
2. **The Student Attendance Window** (Services Tab `الخدمات -> الحضور`):
   - Exclusively student-facing.
   - **Hero Card**: Quick "مسح رمز الحضور (Live Cam)" action button + offline sync status.
   - **Modern Scanner**: [`QrScannerModal.tsx`](file:///f:/Developing/Mohadaraty/MyLecture/src/components/simosan/QrScannerModal.tsx) with animated laser reticle, camera flip, torch, and a "تجربة المسح (Demo Scan)" fallback for desktop testing.
   - **Success Sheet**: Instant verified receipt modal with lecture, subject, and timestamp confirmation.
   - **Tab 1 — المواد والإنذارات**: Overall attendance rate % + per-subject cards with deprivation meters calibrated to the Iraqi Ministry 15% ceiling (Safe, Alert, Warning, Deprived).
   - **Tab 2 — سجل المحاضرات**: Chronological lecture timeline with subject filter pills and status badges (`مؤكد ✓`, `محفوظ محلياً ⚡`, `غائب ✗`, `مجاز ⏱`).

---

## 2. Key Files Manifest

### Doctor Portal
- `src/components/doctor/types.ts`
- `src/components/doctor/mockData.ts`
- `src/components/doctor/SubjectModeModal.tsx`
- `src/components/doctor/DoctorLiveSessionView.tsx`
- `src/components/doctor/DoctorExcelTimetableView.tsx`
- `src/components/doctor/DoctorAnalyticsView.tsx`
- `src/components/doctor/DoctorPortal.tsx`

### Student Attendance in Services
- `src/components/simosan/SimosanPage.tsx`
- `src/components/simosan/StudentSimosanView.tsx`
- `src/components/simosan/QrScannerModal.tsx`

### Settings & App Integration
- `src/components/settings/SettingsScreen.tsx`
- `src/lib/settingsIcons.ts`
- `src/lib/permissions.ts`
- `src/types.ts`
- `src/App.tsx`

---

## 3. Handover for Logic & Backend Agent

1. **Doctor Account Generation**:
   - Wire up the `onClick` in `SettingsScreen.tsx` (Manage Attendance row) to open an account creation modal.
   - Provision Firebase Auth credentials with `role: 'doctor'`, `assignedStageId`, and `assignedSubjects`.
2. **Attendance Backend Integration**:
   - In `DoctorLiveSessionView.tsx`, connect to `POST /api/attendance/sessions` in `shared/attendanceApi.ts`.
   - In `StudentSimosanView.tsx`, QR scans call `captureAttendanceQr()`, write receipts to IndexedDB, and synchronize to Supabase Postgres.
