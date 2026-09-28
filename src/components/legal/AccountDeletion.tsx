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
      <LegalShell lang={lang} setLang={setLang} title="حذف الحساب" updated="آخر تحديث: ٢٨ أيلول ٢٠٢٦">
        <Section heading="التطبيق">
          <p>«محاضراتي» — المنصة الطلابية للمحاضرات الجامعية.</p>
        </Section>

        <Section heading="كيف تطلب حذف حسابك">
          <p>يمكنك طلب حذف حسابك وبياناتك نهائياً بإحدى الطريقتين:</p>
          <div className="space-y-3">
            <div>
              <p className="font-bold text-slate-800 dark:text-stone-200 mb-1">١. من داخل التطبيق:</p>
              <Bullets items={[
                'افتح صفحة «الملف الشخصي» ثم «الإعدادات».',
                'اختر «الحساب والأمان» (أو «إدارة الحساب»).',
                'اضغط «طلب حذف الحساب» وأكّد الطلب.',
              ]} />
            </div>
            <div>
              <p className="font-bold text-slate-800 dark:text-stone-200 mb-1">٢. عبر المراسلة المباشرة (دون الحاجة لتثبيت التطبيق):</p>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                أرسل رسالة من بريدك الإلكتروني المسجل في التطبيق إلى:{' '}
                <a href="mailto:support@myvarmacy.com" className="font-mono text-sky-600 dark:text-sky-400 hover:underline" dir="ltr">
                  support@myvarmacy.com
                </a>{' '}
                واذكر اسمك الكامل ومرحلتك الدراسية، وسيتم تأكيد طلبك والبدء بالحذف فوراً.
              </p>
            </div>
          </div>
        </Section>

        <Section heading="ما الذي يُحذف">
          <Bullets items={[
            'ملفك الشخصي: الاسم المعروض، الصورة الشخصية، المفضلة، المحاضرات المؤشرة، والتفضيلات.',
            'هوية وبيانات الدخول — لن يعود بإمكانك تسجيل الدخول بأي وسيلة.',
            'كلمة المرور المشفرة ورمز الدخول وربط حساب Google.',
            'رمز الإشعارات ومعرف الجهاز الخاص بك.',
            'إجاباتك وسجلاتك في بنوك الأسئلة والاختبارات وإحصاءاتها ودرجاتك ونشاطك وتفاعلك اليومي (الستريك).',
          ]} />
        </Section>

        <Section heading="ما الذي يبقى، ولماذا">
          <p>
            رسائلك وملاحظاتك السابقة في قنوات النقاش ومجموعات المشاركة العامة تبقى لضمان عدم انقطاع سياق الحديث لزملائك الطلبة المشاركين، ولكن يُزال اسمك وهويتك وكافة بياناتك الشخصية عنها نهائياً، وتظهر باسم مجهول («طالب محذوف») دون أي إمكانية للربط بحسابك السابق. لا يحتفظ التطبيق بأي سجلات شخصية أو بيانات قيد بعد إتمام الحذف.
          </p>
        </Section>

        <Section heading="ملاحظة هامة بخصوص الاشتراكات">
          <p>
            حذف الحساب من خوادمنا لا يلغي التجديد التلقائي للاشتراكات المشتراة عبر متجر التطبيقات (Apple App Store أو Google Play). يجب إيقاف وإلغاء الاشتراك حصرياً من قِبل المستخدم عبر إعدادات الاشتراكات في حسابه بنظام التشغيل قبل حذف الحساب.
          </p>
        </Section>

        <Section heading="المدة (SLA)">
          <p>
            تتم مراجعة ومعالجة طلبات الحذف وحذف كافة بياناتك وسجلاتك من قواعد البيانات بشكل نهائي خلال <strong>48 ساعة عمل</strong> كحد أقصى. الحذف نهائي ولا يمكن التراجع عنه أو استرجاع البيانات بعد إتمامه.
          </p>
        </Section>
      </LegalShell>
    );
  }

  return (
    <LegalShell lang={lang} setLang={setLang} title="Delete your account" updated="Last updated: 28 September 2026">
      <Section heading="The app">
        <p>MyLecture — University Student Platform.</p>
      </Section>

      <Section heading="How to request deletion">
        <p>You can request permanent deletion of your account and associated data using either method:</p>
        <div className="space-y-3">
          <div>
            <p className="font-bold text-slate-800 dark:text-stone-200 mb-1">1. From inside the app:</p>
            <Bullets items={[
              'Open Profile and tap Settings.',
              'Choose “Account & Security” (or “Account Management”).',
              'Tap “Request account deletion” and confirm.',
            ]} />
          </div>
          <div>
            <p className="font-bold text-slate-800 dark:text-stone-200 mb-1">2. By email (without installing the app):</p>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Send an email request from your registered address to:{' '}
              <a href="mailto:support@myvarmacy.com" className="font-mono text-sky-600 dark:text-sky-400 hover:underline" dir="ltr">
                support@myvarmacy.com
              </a>{' '}
              specifying your full registered name and academic stage.
            </p>
          </div>
        </div>
      </Section>

      <Section heading="What is deleted">
        <Bullets items={[
          'Your profile: display name, photo, bookmarks, studied lectures, and preferences.',
          'Your sign-in identity — you will no longer be able to log in by any method.',
          'Hashed password, login code, and any linked Google credentials.',
          'Your device push notification token and identifiers.',
          'All quiz and question bank responses, statistics, saved grades, and daily streak activity history.',
        ]} />
      </Section>

      <Section heading="What is retained, and why">
        <p>
          Messages and contributions in public study discussions remain to avoid breaking conversational context for peer students, but are stripped of all personal identity and attributed to an anonymous author (“Deleted Student”). No personal records or identifiable information are retained after deletion.
        </p>
      </Section>

      <Section heading="Important note regarding subscriptions">
        <p>
          Deleting your account from our servers does not automatically cancel auto-renewing subscriptions managed by the App Store or Google Play. Subscriptions must be canceled directly by the user in their operating system account settings.
        </p>
      </Section>

      <Section heading="Timing (SLA)">
        <p>
          Deletion requests are processed and all personal account data is permanently purged from our databases within <strong>48 hours</strong>. Deletion is irreversible once completed.
        </p>
      </Section>
    </LegalShell>
  );
}
