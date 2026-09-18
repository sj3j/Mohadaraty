import React from 'react';
import { LegalShell, Section, Bullets, useLegalLang } from './LegalShell';

/**
 * Public account-deletion instructions, served at /delete-account.
 *
 * Play requires a URL a reviewer can open WITHOUT installing the app, naming
 * the developer and the app, showing how to ask for deletion, and stating what
 * is deleted versus retained. That last part has to be honest: approving a
 * request purges the profile, the sign-in identity and the quiz history, but
 * leaves the college's enrolment record and grades in place - see
 * shared/accountDeletion.ts, which is what actually runs.
 */
export default function AccountDeletion() {
  const [lang, setLang] = useLegalLang();
  const isRtl = lang === 'ar';

  if (isRtl) {
    return (
      <LegalShell lang={lang} setLang={setLang} title="حذف الحساب" updated="آخر تحديث: ٤ أيلول ٢٠٢٦">
        <Section heading="التطبيق">
          <p>«محاضراتي» — تطبيق المحاضرات الجامعية.</p>
        </Section>

        <Section heading="كيف تطلب حذف حسابك">
          <p>من داخل التطبيق:</p>
          <Bullets items={[
            'افتح «الإعدادات».',
            'اختر «الحساب وكلمة المرور».',
            'اضغط «طلب حذف الحساب» وأكّد الطلب.',
          ]} />
          <p>
            يصل الطلب إلى ممثل مرحلتك لمراجعته. يمكنك سحب الطلب من الصفحة نفسها ما دام
            قيد المراجعة. إن تعذّر عليك الدخول إلى التطبيق، راسلنا من بريدك على{' '}
            <span dir="ltr" className="font-mono">support@myvarmacy.com</span> واذكر اسمك
            الكامل ومرحلتك.
          </p>
        </Section>

        <Section heading="ما الذي يُحذف">
          <Bullets items={[
            'ملفك الشخصي: الاسم المعروض، الصورة، المفضلة، المحاضرات المؤشرة، التفضيلات.',
            'هوية الدخول — لن يعود بإمكانك تسجيل الدخول بأي وسيلة.',
            'كلمة المرور ورمز الدخول وربط حساب Google.',
            'رمز الإشعارات الخاص بجهازك.',
            'إجاباتك في الاختبارات وإحصاءاتها وسجل نشاطك اليومي.',
          ]} />
          <p>رسائلك في الدردشة تبقى لأن طلبة آخرين شاركوا فيها، لكن يُزال اسمك عنها وتظهر باسم «طالب محذوف».</p>
        </Section>

        <Section heading="ما الذي يبقى، ولماذا">
          <p>
            تحتفظ الكلية بسجل القيد الأكاديمي: الاسم والرقم الامتحاني والمرحلة والدرجات.
            هذا سجل دراسي رسمي تصدره الكلية ولا يُعدّ بيانات حساب شخصي، وحذفه يعني إتلاف
            نتائج امتحانية. لا يمكن استخدام هذا السجل لتسجيل الدخول بعد الحذف.
          </p>
        </Section>

        <Section heading="المدة">
          <p>تُراجع الطلبات عادةً خلال أيام قليلة. الحذف نهائي ولا يمكن التراجع عنه بعد الموافقة.</p>
        </Section>
      </LegalShell>
    );
  }

  return (
    <LegalShell lang={lang} setLang={setLang} title="Delete your account" updated="Last updated: 4 September 2026">
      <Section heading="The app">
        <p>MyLecture — the university lecture app.</p>
      </Section>

      <Section heading="How to request deletion">
        <p>From inside the app:</p>
        <Bullets items={[
          'Open Settings.',
          'Choose “Account & password”.',
          'Tap “Request account deletion” and confirm.',
        ]} />
        <p>
          The request goes to your stage representative for review. You can withdraw it from
          the same screen while it is still pending. If you cannot sign in, write to us from
          your own address at{' '}
          <span dir="ltr" className="font-mono">support@myvarmacy.com</span> with your full
          name and stage.
        </p>
      </Section>

      <Section heading="What is deleted">
        <Bullets items={[
          'Your profile: display name, photo, favourites, studied lectures, preferences.',
          'Your sign-in identity — you will no longer be able to log in by any method.',
          'Your password, login code, and any linked Google account.',
          'Your device notification token.',
          'Your quiz answers and statistics, and your daily activity history.',
        ]} />
      </Section>

      <Section heading="What is kept, and why">
        <p>
          The college retains the academic enrolment record: name, exam number, stage and
          grades. That is an official study record issued by the college rather than personal
          account data, and deleting it would destroy examination results. It cannot be used
          to sign in after deletion.
        </p>
      </Section>

      <Section heading="Timing">
        <p>Requests are normally reviewed within a few days. Deletion is permanent and cannot be undone once approved.</p>
      </Section>
    </LegalShell>
  );
}
