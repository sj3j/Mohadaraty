# Architectural Pills & Lessons Learned (حبوب وملاحظات معمارية)

هذا الملف يوثق الأخطاء المعمارية المتكررة والمفخخات (Pitfalls) والحلول الجذرية لتجنب تكرارها مستقبلاً.

---

## Pill #1: فشل حفظ حالة المحاضرات المدروسة (تمت دراستها) والمهام الأسبوعية في Firestore

### الأعراض (Symptom)
- عند النقر على زر "تمت دراستها؟" في بطاقة المحاضرة (`LectureCard.tsx`) أو في جدول المهام الأسبوعية (`WeeklyListScreen.tsx`)، لا يتم حفظ الحالة وتختفي بمجرد الانتقال لصفحة أخرى أو إعادة تحميل التطبيق.
- في الكونسول يظهر خطأ:
  `PERMISSION_DENIED: evaluation error at ... false for 'update'`

### السبب الجذري (Root Cause)
في ملف [firestore.rules](firestore.rules)، تخضع التعديلات الذاتية للمستخدم على وثيقته في مجموعة `users/{userId}` إلى شرطين صارمين:
1. دالة التحقق من صحة الحقول `isValidUser(request.resource.data)`:
   كانت تحتوي على التحقق من نوع الحقل:
   ```firestore
   (!('studied' in data) || data.studied is list) &&
   (!('completedWeeklyTasks' in data) || data.completedWeeklyTasks is list)
   ```
2. القائمة البيضاء للحقول المسموح للمستخدم تعديلها بنفسه:
   ```firestore
   (isOwner(userId) && isValidUser(request.resource.data) && (
     request.resource.data.diff(resource.data).affectedKeys().hasOnly([
       'name', 'group', 'photoUrl',
       'hideNameOnLeaderboard', 'hidePhotoOnLeaderboard', 
       'blockedUsers', 'notificationPreferences', 
       'examCodePromptSnoozedUntil', 'lastActiveAt', 'pushToken'
     ])
   ));
   ```
المشكلة كانت أن حقول `studied` و `completedWeeklyTasks` كانت **غائبة تماماً من القائمة البيضاء** `hasOnly([...])`.
بالتالي، عندما كان التطبيق يستدعي:
```typescript
await setDoc(userRef, { studied: arrayUnion(lecture.id) }, { merge: true });
```
كان Firestore يرفض التعديل فوراً بـ `PERMISSION_DENIED`.

### وجه الشبه مع مشكلة تفاعلات الإعلانات (Reactions to Announcements)
سابقاً في شاشة الإعلانات (`AnnouncementsScreen.tsx`)، واجه التطبيق مشكلة مشابهة حيث كان الطلاب يحاولون التفاعل (Reaction)، لكن قواعد Firestore كانت تحصر التعديل على ممثلي المراحل والمشرفين فقط (`canWriteStage`)، فكانت التفاعلات تفشل وترفضها القواعد.

### قائمة التحقق لتفادي الخطأ مستقبلاً (Checklist to Avoid in Future)

1. **التوافق المزدوج في قواعد الحماية (Dual Rule Validation)**:
   - عند إضافة أي حقل جديد يكتبه المستخدم بنفسه في وثيقة حسابه `users/{userId}`:
     - **أولاً**: أضف نوعه في `isValidUser()`.
     - **ثانياً**: أضف اسمه صراحة في مصفوفة `affectedKeys().hasOnly([...])` داخل شرط التحديث `allow update`.

2. **كتابة اختبار انحدار آلي في `scripts/rules.test.mjs`**:
   - لا تعتمد على الفحص البصري فقط؛ أضف دائماً اختباراً يؤكد نجاح الطالب في التعديل:
     ```javascript
     await check('student CAN update their own studied lectures list',
       assertSucceeds(setDoc(doc(student, 'users/stu_uid'), { studied: ['lecture_test_1'] }, { merge: true })));
     ```
   - وتشغيل: `npm run test:rules`.

3. **نشر القواعد على خادم Firebase والتحقق من التطابق**:
   - القواعد المحلية لا تسري على المستخدمين حتى يتم نشرها:
     ```bash
     npx -y firebase-tools@13 deploy --only firestore:rules --project mylectures-app
     ```
   - التحقق من عدم وجود أي انحراف (Drift):
     ```bash
     npm run check:rules
     ```

4. **عدم بلع الأخطاء في واجهة المستخدم (No Silent Error Swallowing)**:
   - عند استدعاء عمليات الحفظ في الواجهة (`LectureCard.tsx` / `WeeklyListScreen.tsx`)، لا تترك كتلة `catch` تطبع فقط في الكونسول `console.error`. يجب إشعار المستخدم فوراً (بواسطة Toast أو Alert) عند فشل الحفظ لتسهيل اكتشاف أي مشاكل في الصلاحيات أو الشبكة فور حدوثها.
