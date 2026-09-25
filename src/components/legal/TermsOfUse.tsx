import React from 'react';
import { LegalShell, Section, Bullets, useLegalLang } from './LegalShell';

export default function TermsOfUse() {
  const [lang, setLang] = useLegalLang();
  const isRtl = lang === 'ar';

  if (isRtl) {
    return (
      <LegalShell lang={lang} setLang={setLang} title="شروط الاستخدام" updated="آخر تحديث: ٢٥ أيلول ٢٠٢٦">
        <Section heading="قبول الشروط">
          <p>
            مرحباً بك في «محاضراتي». باستخدامك لهذا التطبيق أو الموقع الإلكتروني، فإنك توافق على الالتزام بشروط الاستخدام التالية. إذا كنت لا توافق على هذه الشروط، يُرجى عدم استخدام خدماتنا.
          </p>
        </Section>

        <Section heading="الحسابات والتسجيل">
          <p>
            تُنشأ الحسابات في التطبيق عادةً عن طريق إدارة الكلية أو ممثل المرحلة، أو من خلال طلب تسجيل توافق عليه الإدارة. أنت مسؤول عن:
          </p>
          <Bullets items={[
            'تقديم معلومات دقيقة وصحيحة.',
            'الحفاظ على سرية كلمة المرور الخاصة بك وعدم مشاركة حسابك مع أي شخص آخر.',
            'إبلاغنا فوراً بأي استخدام غير مصرح به لحسابك.',
          ]} />
          <p>
            يُحظر تماماً بيع أو تأجير أو مشاركة حسابك. نحتفظ بالحق في تعليق أو إنهاء أي حساب يتبين أنه يشارك بيانات تسجيل الدخول أو ينتهك هذه الشروط، وذلك دون إشعار مسبق أو تعويض.
          </p>
        </Section>

        <Section heading="الاشتراكات والمدفوعات">
          <p>بعض الميزات والمحتويات تتطلب وصولاً أو اشتراكاً فعّالاً:</p>
          <Bullets items={[
            'تتم إدارة الوصول للاشتراكات في نظامنا الأساسي بواسطة إدارة الكلية (خارج التطبيق).',
            'قد يوفر التطبيق (في نسخة iOS فقط) عمليات شراء واشتراكات داخل التطبيق عبر نظام Apple In-App Purchases. تخضع هذه العمليات لشروط وأحكام Apple.',
            'تطبيق الأندرويد لا يحتوي على أي عمليات شراء داخلي، وتتم إدارة الوصول فيه عبر الإدارة حصراً.',
            'كافة المبالغ المدفوعة غير قابلة للاسترداد، ما لم ينص القانون المعمول به على خلاف ذلك.',
          ]} />
        </Section>

        <Section heading="الترخيص والاستخدام المقبول">
          <p>
            نمنحك ترخيصاً شخصياً ومحدوداً وغير حصري وقابل للإلغاء لاستخدام التطبيق للأغراض التعليمية الشخصية فقط. يُحظر عليك:
          </p>
          <Bullets items={[
            'نسخ، أو توزيع، أو تعديل، أو إعادة إنتاج أي جزء من التطبيق أو محتواه.',
            'استخدام برامج آلية (Scrapers/Bots) لجمع المحتوى أو البيانات من التطبيق.',
            'محاولة اختراق أو تجاوز أنظمة الحماية وتصاريح الوصول.',
            'استخدام التطبيق لأي غرض تجاري أو غير قانوني.',
          ]} />
        </Section>

        <Section heading="المحتوى والملكية الفكرية (محتوى المستخدمين)">
          <p>
            يعمل التطبيق كمنصة سحابية دراسية تتيح للمستخدمين (مثل ممثلي المراحل) رفع ومشاركة وتنظيم المواد الدراسية لزملائهم. بقيامك برفع أي محتوى، فإنك تقر بالآتي:
          </p>
          <Bullets items={[
            'أنت تتحمل المسؤولية الكاملة عن الملفات والمحاضرات والمواد التي تقوم برفعها.',
            'أنك تمتلك الحق القانوني أو التصريح أو الإذن بمشاركة هذه المواد.',
            'مطورو التطبيق لا يدعون ملكية الملفات المرفوعة من قبل المستخدمين، ولا نقوم بمراقبة كل المحتوى مسبقاً.',
          ]} />
          <p>
            نحن نحترم حقوق الملكية الفكرية. إذا كنت مالكاً لحقوق الطبع والنشر (مثل أستاذ جامعي أو إدارة الكلية) وتعتقد أن موادك تُنشر دون تصريح، يُرجى التواصل معنا على support@mohadaraty.com لإزالة المحتوى فوراً (طلب إزالة / حقوق نشر).
          </p>
        </Section>

        <Section heading="مساعد الذكاء الاصطناعي (سيموسان)">
          <p>
            يوفر التطبيق أدوات ذكاء اصطناعي تفاعلية لمساعدتك في فهم المحاضرات. يجب أن تدرك الآتي:
          </p>
          <Bullets items={[
            'يتم تقديم هذه الميزات "كما هي" دون ضمانات لدقتها أو اكتمالها.',
            'قد يولد الذكاء الاصطناعي إجابات غير دقيقة أو خاطئة. يجب عليك دائماً التحقق من المعلومات بالرجوع إلى المصادر الأكاديمية والمحاضرة الأصلية.',
            'نحن لسنا مسؤولين عن أي أضرار أكاديمية أو قرارات تتخذها بناءً على إجابات الذكاء الاصطناعي.',
          ]} />
        </Section>

        <Section heading="إخلاء المسؤولية وتحديد المسؤولية">
          <p>
            يُقدم التطبيق وخدماته على أساس "كما هو" و"كما هو متاح". لا نقدم أي ضمانات بأن الخدمة ستكون خالية من الأخطاء أو الانقطاعات.
          </p>
          <p>
            إلى أقصى حد يسمح به القانون، لا نتحمل نحن ولا الكلية أي مسؤولية عن أي أضرار مباشرة، أو غير مباشرة، أو عرضية، أو تبعية ناتجة عن استخدامك للتطبيق، بما في ذلك على سبيل المثال لا الحصر: الفشل الأكاديمي، أو فقدان البيانات، أو توقف الخدمة.
          </p>
        </Section>

        <Section heading="تعديل الشروط">
          <p>
            نحتفظ بالحق في تعديل هذه الشروط في أي وقت. استمرارك في استخدام التطبيق بعد نشر التغييرات يُعد قبولاً منك لتلك الشروط المعدلة.
          </p>
        </Section>
      </LegalShell>
    );
  }

  return (
    <LegalShell lang={lang} setLang={setLang} title="Terms of Use" updated="Last updated: 25 September 2026">
      <Section heading="Acceptance of Terms">
        <p>
          Welcome to MyLecture. By accessing or using our application and website, you agree to be bound by these Terms of Use. If you do not agree to these terms, please do not use our services.
        </p>
      </Section>

      <Section heading="Accounts & Registration">
        <p>
          Accounts in the app are generally created by your college administration or stage representative, or through an approved signup request. You are responsible for:
        </p>
        <Bullets items={[
          'Providing accurate and true information.',
          'Maintaining the confidentiality of your password and not sharing your account with anyone else.',
          'Immediately notifying us of any unauthorized use of your account.',
        ]} />
        <p>
          Selling, renting, or sharing your account is strictly prohibited. We reserve the right to suspend or terminate any account found to be sharing login credentials or violating these terms, without prior notice or compensation.
        </p>
      </Section>

      <Section heading="Subscriptions & Payments">
        <p>Some features and content require an active access or subscription:</p>
        <Bullets items={[
          'Subscription access on our primary platform is managed by the college administration (off-platform).',
          'The app may offer in-app purchases and subscriptions (on the iOS app only) via Apple In-App Purchases. These are subject to Apple’s terms and conditions.',
          'The Android app contains no in-app purchases, and access is managed exclusively by the administration.',
          'All payments made are final and non-refundable, unless otherwise required by applicable law.',
        ]} />
      </Section>

      <Section heading="License & Acceptable Use">
        <p>
          We grant you a personal, limited, non-exclusive, and revocable license to use the app solely for your personal educational purposes. You may not:
        </p>
        <Bullets items={[
          'Copy, distribute, modify, or reproduce any part of the app or its content.',
          'Use automated software (scrapers/bots) to collect content or data from the app.',
          'Attempt to hack, bypass, or circumvent our security systems and access controls.',
          'Use the app for any commercial or illegal purpose.',
        ]} />
      </Section>

      <Section heading="Content & Intellectual Property (User-Generated Content)">
        <p>
          The application acts as a cloud study platform where users (such as student representatives) can upload, share, and organize study materials for their peers. By uploading content, you acknowledge that:
        </p>
        <Bullets items={[
          'You retain all responsibility for the files, lectures, and materials you upload.',
          'You have the lawful right, license, or permission to share these materials.',
          'The app developers do not claim ownership of user-uploaded files, nor do we pre-screen all content.',
        ]} />
        <p>
          We respect intellectual property rights. If you are a copyright owner (e.g., a university professor or administration) and believe your work is being distributed without authorization, please contact us at support@mohadaraty.com for immediate takedown (DMCA / Copyright request).
        </p>
      </Section>

      <Section heading="Artificial Intelligence Tools (Simosan)">
        <p>
          The app provides interactive artificial intelligence tools to assist in your understanding of the lectures. You acknowledge that:
        </p>
        <Bullets items={[
          'These features are provided "as-is" without any warranties of accuracy or completeness.',
          'The AI may generate inaccurate or false responses. You must always verify the information by referring to academic sources and the original lecture.',
          'We are not liable for any academic damages or decisions made based on AI-generated responses.',
        ]} />
      </Section>

      <Section heading="Disclaimers & Limitation of Liability">
        <p>
          The app and its services are provided on an "as-is" and "as-available" basis. We do not guarantee that the service will be error-free or uninterrupted.
        </p>
        <p>
          To the maximum extent permitted by law, neither we nor the college shall be liable for any direct, indirect, incidental, or consequential damages arising from your use of the app, including but not limited to: academic failure, loss of data, or service interruptions.
        </p>
      </Section>

      <Section heading="Modifications to Terms">
        <p>
          We reserve the right to modify these terms at any time. Your continued use of the app following the posting of changes constitutes your acceptance of the revised terms.
        </p>
      </Section>
    </LegalShell>
  );
}
