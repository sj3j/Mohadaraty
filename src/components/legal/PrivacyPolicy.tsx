import React from 'react';
import { LegalShell, Section, Bullets, useLegalLang } from './LegalShell';

/**
 * The privacy policy, served at /privacy without a login.
 *
 * Play requires the URL to be public and the content to match what the app
 * actually does, so everything below is drawn from the real data model rather
 * than a template: the `students` and `users` collections, Cloudflare R2 for
 * recordings, Firebase for auth/storage/messaging, and the stage-scoped access
 * rules in firestore.rules.
 *
 * It names the payment processors truthfully, and they now differ per platform:
 * ZainCash on the website, Apple's In-App Purchase in the iOS app (with
 * RevenueCat recording what an account holds), and NOTHING in the Android app,
 * which sells nothing at all. That is why src/components/legal/ is pinned into
 * its own `legal-` chunk in vite.config.ts: scripts/assert-no-payment-surface.mjs
 * exempts that chunk precisely so an accurate disclosure is possible without
 * weakening the check that keeps a purchase FLOW out of the build that may not
 * have one.
 *
 * Keep this list in step with what each build actually does. Apple reviews the
 * policy against the app's own privacy declarations, and a policy that omits
 * the processor handling the money is a rejection.
 */
export default function PrivacyPolicy() {
  const [lang, setLang] = useLegalLang();
  const isRtl = lang === 'ar';

  if (isRtl) {
    return (
      <LegalShell lang={lang} setLang={setLang} title="سياسة الخصوصية" updated="آخر تحديث: ٢١ أيلول ٢٠٢٦">
        <Section heading="من نحن">
          <p>
            «محاضراتي» تطبيق تديره إدارة الكلية لتوصيل المحاضرات والتسجيلات والإعلانات
            والدرجات لطلبة المراحل الدراسية. للاستفسار عن بياناتك راسلنا على{' '}
            <span dir="ltr" className="font-mono">support@myvarmacy.com</span>.
          </p>
        </Section>

        <Section heading="البيانات التي نجمعها">
          <p>الحساب يُنشئه ممثل المرحلة من قائمة الطلبة، أو تُنشئه أنت بطلب تسجيل:</p>
          <Bullets items={[
            'الاسم الكامل، والمجموعة، والمرحلة الدراسية.',
            'الرقم الامتحاني — إن أدخلته أنت أو أدخلته الإدارة.',
            'البريد الإلكتروني إن وُجد. الطلبة المستوردون من قائمة أسماء لا يملكون بريداً، ويدخلون باسمهم أو برمز دخول قصير.',
            'كلمة المرور، مخزّنة مشفّرة دائماً ولا يمكن لأحد قراءتها — بما فينا.',
            'الصورة الشخصية إن رفعتها.',
            'رسائلك في الدردشة ومرفقاتها.',
            'إجاباتك في الاختبارات ونتائجها، ودرجاتك، ونشاطك اليومي (الستريك).',
            'رمز الإشعارات الخاص بجهازك، لإرسال تنبيهات المحاضرات والإعلانات.',
          ]} />
        </Section>

        <Section heading="لماذا نستخدمها">
          <Bullets items={[
            'تسجيل دخولك وربطك بمرحلتك ومجموعتك.',
            'عرض محتوى مرحلتك فقط دون غيرها.',
            'حفظ تقدّمك الدراسي ودرجاتك ونتائج اختباراتك.',
            'إرسال إشعارات عند إضافة محاضرة أو إعلان أو واجب.',
          ]} />
          <p>لا نستخدم بياناتك للإعلانات، ولا نبيعها لأي جهة.</p>
        </Section>

        <Section heading="من يستطيع رؤية بياناتك">
          <Bullets items={[
            'ممثل مرحلتك والمشرفون عليها — ويقتصر وصولهم على مرحلتهم وحدها.',
            'مدير النظام.',
            'الطلبة الآخرون يرون اسمك وصورتك في الدردشة ولوحة الصدارة، ويمكنك إخفاء اسمك وصورتك من لوحة الصدارة من الإعدادات.',
          ]} />
        </Section>

        <Section heading="مزوّدو الخدمة">
          <p>نعتمد على مزودي خدمات سحابية وبنية تحتية موثوقين لمعالجة البيانات نيابةً عنا:</p>
          <Bullets items={[
            'خدمات البنية التحتية — لإدارة الحسابات، وقواعد البيانات، وتخزين الملفات والتسجيلات الصوتية، واستضافة الموقع، وإرسال الإشعارات.',
            'بوابات الدفع الإلكتروني — لمعالجة عمليات الدفع وإدارة الاشتراكات (في نسخة الموقع الإلكتروني وتطبيق iOS فقط). تتم جميع عمليات الدفع عبر بوابات آمنة تابعة لجهات خارجية، ولا نطّلع على بيانات بطاقتك أو معلوماتك المالية مطلقاً.',
            'تطبيق الأندرويد لا يتضمن أي عملية دفع أو شراء داخلي.',
          ]} />
        </Section>

        <Section heading="مدة الحفظ">
          <p>
            نحتفظ ببيانات حسابك ما دام الحساب فعّالاً. عند حذف الحساب تُحذف بياناتك الشخصية،
            وتبقى لدى الكلية سجلات القيد الأكاديمي — الاسم والرقم الامتحاني والمرحلة والدرجات —
            بوصفها سجلاً دراسياً رسمياً. تفاصيل ما يُحذف وما يبقى في{' '}
            <a href="/delete-account" className="text-sky-600 dark:text-sky-400 hover:underline">صفحة حذف الحساب</a>.
          </p>
        </Section>

        <Section heading="حقوقك">
          <Bullets items={[
            'الاطلاع على بياناتك وتصحيحها من صفحة الملف الشخصي.',
            'تغيير كلمة المرور، وربط أو فصل حساب Google، من الإعدادات.',
            'طلب حذف حسابك من داخل التطبيق أو بمراسلتنا.',
          ]} />
        </Section>

        <Section heading="الأمان">
          <p>
            كلمات المرور مخزّنة مشفّرة، والوصول إلى بيانات كل مرحلة محصور بممثليها عبر قواعد
            صلاحيات على مستوى قاعدة البيانات. ورغم ذلك لا يمكن ضمان أمان مطلق لأي نظام على
            الإنترنت.
          </p>
        </Section>

        <Section heading="الأطفال">
          <p>التطبيق موجّه لطلبة الجامعة، ولا نجمع بيانات من هم دون الثالثة عشرة عن قصد.</p>
        </Section>

        <Section heading="تغييرات على هذه السياسة">
          <p>سنحدّث هذه الصفحة عند تغيّر ما نجمعه، مع تعديل تاريخ آخر تحديث أعلاه.</p>
        </Section>
      </LegalShell>
    );
  }

  return (
    <LegalShell lang={lang} setLang={setLang} title="Privacy Policy" updated="Last updated: 21 September 2026">
      <Section heading="Who we are">
        <p>
          MyLecture is an app run by the college administration to deliver lectures,
          recordings, announcements and grades to students in each academic stage.
          For any question about your data, write to{' '}
          <span dir="ltr" className="font-mono">support@myvarmacy.com</span>.
        </p>
      </Section>

      <Section heading="What we collect">
        <p>Your account is created by your stage representative from the class roster, or by you through a signup request:</p>
        <Bullets items={[
          'Full name, group, and academic stage.',
          'Exam number, if you or the administration entered one.',
          'Email address, where one exists. Students imported from a name list have no email and sign in with their name or a short login code.',
          'Your password, always stored hashed and readable by nobody, including us.',
          'A profile photo, if you upload one.',
          'Quiz answers and results, grades, and daily activity (streak).',
          'Your device notification token, used to alert you to new lectures and announcements.',
        ]} />
      </Section>

      <Section heading="Why we use it">
        <Bullets items={[
          'To sign you in and connect you to your stage and group.',
          'To show you your own stage’s content and no one else’s.',
          'To keep your academic progress, grades and quiz results.',
          'To notify you when a lecture, announcement or homework is added.',
        ]} />
        <p>We do not use your data for advertising, and we do not sell it to anyone.</p>
      </Section>

      <Section heading="Who can see your data">
        <Bullets items={[
          'Your stage representative and its moderators — their access is limited to their own stage.',
          'The system administrator.',
          'Other students see your name and photo on the leaderboard; you can hide both from it in Settings.',
        ]} />
      </Section>

      <Section heading="Service providers">
        <p>We rely on trusted cloud and infrastructure service providers to process data on our behalf:</p>
        <Bullets items={[
          'Infrastructure services — for managing accounts, databases, file and audio storage, website hosting, and sending notifications.',
          'Payment gateways — for processing payments and managing subscriptions (on the website and iOS app only). All payments are handled by secure third-party gateways; we never see or store your card or financial details.',
          'The Android app contains no payment or in-app purchase flow.',
        ]} />
      </Section>

      <Section heading="How long we keep it">
        <p>
          We keep your account data for as long as the account is active. When an account is
          deleted, your personal data is removed and the college retains the academic
          enrolment record — name, exam number, stage and grades — as an official study
          record. What is deleted and what is kept is set out on the{' '}
          <a href="/delete-account" className="text-sky-600 dark:text-sky-400 hover:underline">account deletion page</a>.
        </p>
      </Section>

      <Section heading="Your rights">
        <Bullets items={[
          'View and correct your data from the profile page.',
          'Change your password, and link or unlink a Google account, in Settings.',
          'Request deletion of your account from inside the app, or by writing to us.',
        ]} />
      </Section>

      <Section heading="Security">
        <p>
          Passwords are stored hashed, and access to each stage’s data is restricted to that
          stage’s staff by database-level security rules. No system on the internet can be
          guaranteed absolutely secure.
        </p>
      </Section>

      <Section heading="Children">
        <p>The app is intended for university students. We do not knowingly collect data from anyone under 13.</p>
      </Section>

      <Section heading="Changes to this policy">
        <p>We will update this page when what we collect changes, and revise the date above.</p>
      </Section>
    </LegalShell>
  );
}
