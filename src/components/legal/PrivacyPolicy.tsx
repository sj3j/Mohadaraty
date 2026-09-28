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
      <LegalShell lang={lang} setLang={setLang} title="سياسة الخصوصية" updated="آخر تحديث: ٢٨ أيلول ٢٠٢٦">
        <Section heading="من نحن">
          <p>
            «محاضراتي» منصة وتطبيق دراسي طُوِّر بمبادرة وإشراف طلابي لتنظيم وتوصيل المحاضرات والتسجيلات الصوتية وبنوك الأسئلة والاختبارات لطلبة المراحل الدراسية، لتوفير بيئة تعليمية مرتبة وموحدة كبديل عملي عن تشتت قنوات ومجموعات التليجرام. التطبيق أداة دراسية مساعدة ولا يتبع لإدارة أي كلية أو جهة رسمية بشكل إداري مباشر. للاستفسار عن بياناتك راسلنا على:{' '}
            <a href="mailto:support@myvarmacy.com" className="font-mono text-sky-600 dark:text-sky-400 hover:underline" dir="ltr">support@myvarmacy.com</a>.
          </p>
        </Section>

        <Section heading="البيانات التي نجمعها">
          <p>الحساب يُنشئه ممثل المرحلة أو المشرف الدراسي من قائمة الطلبة، أو تُنشئه أنت بالتسجيل المباشر:</p>
          <Bullets items={[
            'الاسم الكامل، والمجموعة، والمرحلة الدراسية.',
            'الرقم التعريفي أو الجامعي — إن أدخلته أنت أو أُدرج ضمن بيانات المرحلة.',
            'البريد الإلكتروني إن وُجد. الطلبة المسجلون عبر قوائم المرحلة يمكنهم تسجيل الدخول باسمهم أو برمز وصول مخصص.',
            'كلمة المرور، مخزّنة بتقنيات تشفير أحادية الاتجاه دائماً ولا يمكن لأحد قراءتها — بما فينا.',
            'الصورة الشخصية إن قمت برفعها لملفك.',
            'رسائلك وملاحظاتك في أقسام المشاركة ومرفقاتها.',
            'إجاباتك في بنوك الأسئلة ونتائجها، ودرجاتك المحفوظة، ونشاطك وتفاعلك اليومي.',
            'رمز الإشعارات ومعرف الجهاز، لإرسال تنبيهات بالمحاضرات والإعلانات الدراسية الجديدة.',
            'بيانات الاستحقاق الرقمي، للتحقق من سريان الاشتراكات وتفعيل الميزات المخصصة دون حفظ أي معلومات مالية.',
          ]} />
        </Section>

        <Section heading="لماذا نستخدمها">
          <Bullets items={[
            'تسجيل دخولك وربطك بمحتوى مرحلتك الدراسية ومجموعتك.',
            'عرض مقررات ومحاضرات مرحلتك فقط دون غيرها لتجنب التشتيت.',
            'حفظ تقدّمك الدراسي ودرجاتك وسجل اختباراتك لمتابعة مستواك الأكاديمي.',
            'إرسال إشعارات فورية عند إضافة محاضرة أو بنك أسئلة أو تنبيه دراسي جديد.',
            'تفعيل وصيانة الميزات المتقدمة وتأكيد سريان الباقات المشترك بها.',
          ]} />
          <p className="font-semibold text-slate-700 dark:text-slate-200">
            لا نستخدم بياناتك للإعلانات التجارية، ولا نبيعها لأي طرف مطلقاً.
          </p>
        </Section>

        <Section heading="من يستطيع رؤية بياناتك">
          <Bullets items={[
            'ممثلو المراحل والمشرفون: يقتصر وصولهم التنظيمي على مرحلتهم الدراسية وحدها لإدارة الجداول ومتابعة المتطلبات.',
            'المشرفون التقنيون: لصيانة قواعد البيانات وضمان استقرار النظام.',
            'الطلبة الآخرون: يرون اسمك وصورتك في لوحة الصدارة وميزات التفاعل، ويمكنك التحكم في إخفاء اسمك وصورتك من الظهور للعامة من صفحة الإعدادات.',
          ]} />
        </Section>

        <Section heading="مزوّدو الخدمة">
          <p>نعتمد على مزودي خدمات بنية تحتية سحابية موثوقين ومؤمنين لمعالجة وتخزين البيانات وتشغيل المنصة نيابةً عنا:</p>
          <Bullets items={[
            'خدمات البنية التحتية السحابية: لإدارة وتوثيق الحسابات، وتأمين قواعد البيانات، وتخزين الملفات والتسجيلات والمستندات واستضافتها، وإرسال التنبيهات اللحظية.',
            'خدمات إدارة ومزامنة الاشتراكات الرقمية: للتحقق من صحة إيصالات الشراء وتفعيل الصلاحيات. تتم جميع المعاملات المالية عبر الأنظمة الرقمية الرسمية المعتمدة لمتجر التطبيقات، ولا تطّلع أنظمتنا على أرقام بطاقاتك الائتمانية أو بياناتك المالية إطلاقاً.',
          ]} />
        </Section>

        <Section heading="مدة الحفظ وحذف الحساب (Data & Account Deletion)">
          <p>نحتفظ ببيانات حسابك ما دام الحساب نشطاً وقيد الاستخدام:</p>
          <Bullets items={[
            'حذف الحساب من داخل التطبيق: يمكنك في أي وقت طلب حذف حسابك نهائياً من خلال: الملف الشخصي -> الإعدادات -> إدارة الحساب -> حذف الحساب.',
            'عبر المراسلة: يمكنك إرسال طلب حذف من بريدك المسجل إلى: support@myvarmacy.com، وسيتم حذف حسابك وكافة سجلاتك ونشاطك من قواعد البيانات بشكل نهائي خلال 48 ساعة. تفاصيل ما يُحذف وما يبقى موضحة أيضاً في صفحة حذف الحساب الرسمية.',
            'ملاحظة بخصوص الاشتراكات: حذف الحساب من خوادمنا لا يلغي التجديد التلقائي للاشتراك في متجر التطبيقات؛ يتم إيقاف الاشتراك حصرياً من قِبل المستخدم عبر إعدادات الاشتراكات في حسابه بنظام التشغيل.',
          ]} />
          <p>
            لمزيد من المعلومات حول آلية حذف الحساب، تفضل بزيارة{' '}
            <a href="/delete-account" className="text-sky-600 dark:text-sky-400 hover:underline font-semibold">
              صفحة حذف الحساب
            </a>.
          </p>
        </Section>

        <Section heading="حقوقك">
          <Bullets items={[
            'الاطلاع على بياناتك وتحديثها من صفحة الملف الشخصي.',
            'تغيير كلمة المرور وربط أو إدارة وسائل الدخول من الإعدادات.',
            'التحكم في خيارات الخصوصية وإخفاء النشاط من لوحة الصدارة.',
            'حذف حسابك وبياناتك الشخصية نهائياً في أي وقت.',
          ]} />
        </Section>

        <Section heading="الأمان">
          <p>
            كلمات المرور والبيانات الحساسة مخزنة ومشفرة، والوصول إلى بيانات كل مرحلة محكوم بقواعد صلاحيات صارمة تمنع التداخل أو الوصول غير المصرح به. ورغم اتباعنا لأفضل المعايير التقنية، لا يمكن ضمان أمان مطلق لأي نظام متصل بالإنترنت.
          </p>
        </Section>

        <Section heading="الخصوصية والطلبة">
          <p>المنصة موجهة لطلبة الجامعات، ولا نجمع عمداً بيانات من هم دون سن الاستخدام الأكاديمي القانوني.</p>
        </Section>

        <Section heading="تغييرات على هذه السياسة">
          <p>سنحدّث هذه الصفحة عند إدخال أي تعديلات على آلية معالجة البيانات، وسينعكس ذلك على تاريخ «آخر تحديث» في أعلى الصفحة.</p>
        </Section>

        <div className="pt-4 border-t border-slate-200 dark:border-zinc-800 text-xs text-slate-500 dark:text-slate-400 space-y-1">
          <p className="font-bold text-slate-700 dark:text-slate-300">محاضراتي — المنصة الطلابية للمحاضرات الجامعية</p>
          <p>
            الدعم الفني:{' '}
            <a href="mailto:support@myvarmacy.com" className="font-mono text-sky-600 dark:text-sky-400 hover:underline" dir="ltr">
              support@myvarmacy.com
            </a>
          </p>
        </div>
      </LegalShell>
    );
  }

  return (
    <LegalShell lang={lang} setLang={setLang} title="Privacy Policy" updated="Last updated: 28 September 2026">
      <Section heading="Who we are">
        <p>
          “MyLecture” is an academic platform and application developed under student initiative and supervision to organize and deliver lectures, audio recordings, question banks, and quizzes to students across academic stages, providing a structured, unified learning environment as a practical alternative to scattered Telegram channels and groups. The app is a supplementary study tool and is not administratively affiliated with any college or official entity. For inquiries regarding your data, contact us at:{' '}
          <a href="mailto:support@myvarmacy.com" className="font-mono text-sky-600 dark:text-sky-400 hover:underline" dir="ltr">support@myvarmacy.com</a>.
        </p>
      </Section>

      <Section heading="What we collect">
        <p>Your account is created by your stage representative or academic moderator from the student roster, or created by you through direct registration:</p>
        <Bullets items={[
          'Full name, group, and academic stage.',
          'Student ID or university identifier — if entered by you or included within stage roster records.',
          'Email address, where available. Students registered via stage rosters can sign in with their name or dedicated access code.',
          'Password, always stored using one-way cryptographic hashing and readable by nobody — including us.',
          'Profile picture, if uploaded to your profile.',
          'Messages, notes, and attachments in shared discussion areas.',
          'Quiz and question bank answers and results, saved grades, and daily streak activity.',
          'Device push notification token and device identifier, to deliver alerts for new lectures and academic notices.',
          'Digital entitlement data, to verify subscription validity and enable premium features without storing any financial or payment information.',
        ]} />
      </Section>

      <Section heading="Why we use it">
        <Bullets items={[
          'To sign you in and connect you to your stage content and academic group.',
          'To display only your academic stage’s curriculum and lectures to prevent distraction.',
          'To preserve your academic progress, grades, and quiz records to track your academic performance.',
          'To send instant push notifications when a new lecture, question bank, or academic notice is posted.',
          'To activate and maintain advanced features and confirm active subscribed packages.',
        ]} />
        <p className="font-semibold text-slate-700 dark:text-slate-200">
          We do not use your data for commercial advertising, and we never sell your data to any third party.
        </p>
      </Section>

      <Section heading="Who can see your data">
        <Bullets items={[
          'Stage representatives and moderators: Their organizational access is strictly restricted to their own academic stage to manage schedules and monitor requirements.',
          'Technical administrators: For database maintenance, stability, and system security.',
          'Other students: See your display name and photo on the leaderboard and interactive features. You can hide your name and photo from public view in Settings.',
        ]} />
      </Section>

      <Section heading="Service providers">
        <p>We rely on trusted and secure cloud infrastructure service providers to process, store data, and operate the platform on our behalf:</p>
        <Bullets items={[
          'Cloud infrastructure services: For account identity management and authentication, database security, file/audio/document storage and hosting, and real-time push notifications.',
          'Digital subscription management and synchronization: To validate purchase receipts and activate entitlements. All financial transactions are handled exclusively through the official digital billing systems of the App Store and Google Play; our systems never view or store credit card numbers or financial details.',
        ]} />
      </Section>

      <Section heading="Data retention and account deletion">
        <p>We retain your account data for as long as your account remains active and in use:</p>
        <Bullets items={[
          'In-app account deletion: You can request permanent account deletion at any time via: Profile -> Settings -> Account Management -> Delete Account.',
          'Via email: You can send a deletion request from your registered email to: support@myvarmacy.com. Your account, records, and activity will be permanently deleted from our databases within 48 hours.',
          'Note regarding subscriptions: Deleting your account from our servers does not cancel auto-renewing subscriptions in the app store; subscriptions must be canceled directly by the user in their operating system account subscription settings.',
        ]} />
        <p>
          For complete details regarding account deletion, please visit our{' '}
          <a href="/delete-account" className="text-sky-600 dark:text-sky-400 hover:underline font-semibold">
            Account Deletion Page
          </a>.
        </p>
      </Section>

      <Section heading="Your rights">
        <Bullets items={[
          'Access and update your personal information from your profile page.',
          'Change password and manage login methods from Settings.',
          'Control privacy settings and hide your activity from the public leaderboard.',
          'Permanently delete your account and personal data at any time.',
        ]} />
      </Section>

      <Section heading="Security">
        <p>
          Passwords and sensitive data are encrypted and securely stored. Access to each academic stage is protected by strict permission rules preventing cross-stage access or unauthorized entry. While we follow industry-standard security practices, no internet-connected system can be guaranteed completely impenetrable.
        </p>
      </Section>

      <Section heading="Privacy and students">
        <p>The platform is intended for university students. We do not knowingly collect personal information from individuals below the legal academic age.</p>
      </Section>

      <Section heading="Changes to this policy">
        <p>We will update this page if our data processing practices change, which will be reflected in the “Last updated” date at the top of this page.</p>
      </Section>

      <div className="pt-4 border-t border-slate-200 dark:border-zinc-800 text-xs text-slate-500 dark:text-slate-400 space-y-1">
        <p className="font-bold text-slate-700 dark:text-slate-300">MyLecture — University Student Platform</p>
        <p>
          Technical Support:{' '}
          <a href="mailto:support@myvarmacy.com" className="font-mono text-sky-600 dark:text-sky-400 hover:underline" dir="ltr">
            support@myvarmacy.com
          </a>
        </p>
      </div>
    </LegalShell>
  );
}
