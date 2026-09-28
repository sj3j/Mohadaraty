import React, { useState } from 'react';
import {
  Mail,
  RotateCcw,
  Clock,
  ExternalLink,
  ChevronDown,
  CheckCircle2,
  AlertCircle,
  Send,
  Copy,
  Check,
  ShieldCheck,
  HelpCircle,
  CreditCard
} from 'lucide-react';
import { LegalShell, Section, useLegalLang } from '../components/legal/LegalShell';
import { apiUrl } from '../lib/apiBase';

interface FaqItem {
  id: string;
  questionAr: string;
  questionEn: string;
  answerAr: React.ReactNode;
  answerEn: React.ReactNode;
}

const SUPPORT_EMAIL = 'support@myvarmacy.com';

export default function SupportPage() {
  const [lang, setLang] = useLegalLang();
  const isRtl = lang === 'ar';

  const [copiedEmail, setCopiedEmail] = useState(false);
  const [openAccordion, setOpenAccordion] = useState<string | null>('sub-restore');

  // Contact Form State
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formCategory, setFormCategory] = useState('subscription');
  const [formMessage, setFormMessage] = useState('');
  const [formErrors, setFormErrors] = useState<{ name?: string; email?: string; message?: string }>({});
  const [formSubmitted, setFormSubmitted] = useState(false);
  const [ticketId, setTicketId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleCopyEmail = () => {
    navigator.clipboard.writeText(SUPPORT_EMAIL);
    setCopiedEmail(true);
    setTimeout(() => setCopiedEmail(false), 2500);
  };

  const validateForm = () => {
    const errors: { name?: string; email?: string; message?: string } = {};
    if (!formName.trim() || formName.trim().length < 2) {
      errors.name = isRtl
        ? 'يرجى إدخال الاسم الكامل (حرفين على الأقل)'
        : 'Please enter your full name (at least 2 characters)';
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!formEmail.trim() || !emailRegex.test(formEmail.trim())) {
      errors.email = isRtl
        ? 'يرجى إدخال بريد إلكتروني صحيح لتلقي الرد'
        : 'Please enter a valid email address';
    }
    if (!formMessage.trim() || formMessage.trim().length < 10) {
      errors.message = isRtl
        ? 'يرجى كتابة تفاصيل الاستفسار (10 أحرف على الأقل)'
        : 'Please enter inquiry details (at least 10 characters)';
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch(apiUrl('/api/support/ticket'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          email: formEmail.trim(),
          category: formCategory,
          message: formMessage.trim(),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || (isRtl ? 'تعذر إرسال الاستفسار، يرجى المحاولة لاحقاً' : 'Failed to submit inquiry, please try again'));
      }

      setTicketId(data.ticketId);
      setFormSubmitted(true);
    } catch (err: any) {
      console.error('Support ticket submission error:', err);
      setSubmitError(err.message || (isRtl ? 'حدث خطأ في الاتصال، يرجى المحاولة مرة أخرى أو مراسلتنا بالبريد.' : 'Network error. Please try again or email us directly.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleFaq = (id: string) => {
    setOpenAccordion(prev => (prev === id ? null : id));
  };

  const faqItems: FaqItem[] = [
    {
      id: 'sub-restore',
      questionAr: 'استعادة المشتريات (Restore Purchases): كيف أستعيد اشتراكي؟',
      questionEn: 'Restore Purchases: How do I restore my subscription?',
      answerAr: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            إذا قمت بتغيير جهازك، أو تهيئة جهازك الحالي، أو إعادة تثبيت التطبيق، يمكنك استعادة اشتراكك الفعّال دون أي تكلفة إضافية باتباع الخطوات التالية:
          </p>
          <ol className="list-decimal list-inside space-y-1 ps-1 font-medium text-slate-800 dark:text-stone-200">
            <li>تأكد من تسجيل الدخول إلى جهازك بنفس الحساب (Apple ID أو Google) الذي استُخدم في الشراء.</li>
            <li>افتح تطبيق <strong>محاضراتي</strong> وتوجه إلى شاشة الاشتراك أو الباقة.</li>
            <li>اضغط على زر <strong>«استعادة المشتريات» (Restore Purchases)</strong> في أسفل الشاشة.</li>
          </ol>
          <p className="text-xs text-slate-500 dark:text-slate-400 pt-1">
            سيتم الاتصال بمتجر التطبيقات والتحقق من صلاحية الإيصال المشفر وتفعيل ميزاتك فوراً.
          </p>
        </div>
      ),
      answerEn: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            If you changed your device, reset it, or reinstalled the app, you can restore your active subscription at no additional cost:
          </p>
          <ol className="list-decimal list-inside space-y-1 ps-1 font-medium text-slate-800 dark:text-stone-200">
            <li>Ensure you are signed in to your device with the same account (Apple ID or Google) used for purchase.</li>
            <li>Open the <strong>MyLecture</strong> app and navigate to the subscription screen.</li>
            <li>Tap <strong>“Restore Purchases”</strong> at the bottom of the screen.</li>
          </ol>
          <p className="text-xs text-slate-500 dark:text-slate-400 pt-1">
            The store will validate your encrypted receipt and restore all features immediately.
          </p>
        </div>
      )
    },
    {
      id: 'sub-manage',
      questionAr: 'إدارة وإلغاء الاشتراك (Subscription Management & Auto-Renewal)',
      questionEn: 'Managing or cancelling auto-renewing subscriptions',
      answerAr: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            يتم تجديد الاشتراكات داخل التطبيق تلقائياً ما لم يتم إلغاء التجديد قبل نهاية الفترة الحالية بـ <strong>24 ساعة على الأقل</strong>. يمكنك التحكم الكامل باشتراكك أو إلغائه مباشرة عبر إعدادات جهازك:
          </p>
          <div className="p-3 rounded-xl bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-900/50 text-xs space-y-1">
            <span className="font-bold text-sky-800 dark:text-sky-300 block">مسار الإلغاء على نظام iOS:</span>
            <p className="font-mono text-slate-700 dark:text-slate-300">الإعدادات ← Apple ID ← الاشتراكات ← محاضراتي ← إلغاء الاشتراك</p>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            عند الإلغاء، يستمر وصولك للمحتوى حتى نهاية دورة الفوترة المدفوعة ولن يتم خصم أي مبالغ لاحقة.
          </p>
        </div>
      ),
      answerEn: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            In-app subscriptions renew automatically unless cancelled at least <strong>24 hours</strong> before the end of the current billing cycle. You can manage or cancel your subscription directly in your device settings:
          </p>
          <div className="p-3 rounded-xl bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-900/50 text-xs space-y-1">
            <span className="font-bold text-sky-800 dark:text-sky-300 block">iOS Cancellation Path:</span>
            <p className="font-mono text-slate-700 dark:text-slate-300">Settings → Apple ID profile → Subscriptions → MyLecture → Cancel Subscription</p>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Upon cancellation, access remains active until the end of the paid billing period.
          </p>
        </div>
      )
    },
    {
      id: 'sub-refund',
      questionAr: 'طلب الاسترداد وسياسة الفوترة (Refund Policy & Store Billing)',
      questionEn: 'Refund policy and store billing',
      answerAr: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            تتم كافة المعاملات المالية، والفوترة، وعمليات الخصم للاشتراكات داخل التطبيق حصرياً بواسطة متجر التطبيقات الرسمي (Apple App Store أو Google Play) ووفقاً لشروطه وأحكامه.
          </p>
          <p>
            فريق المنصة لا يطّلع على بيانات بطاقتك الائتمانية ولا يملك صلاحية تعديل الرسوم أو رد المبالغ مباشرة. لطلب استرداد الأموال لأي اشتراك، يرجى التقديم عبر بوابة الدعم الرسمية لـ Apple:
          </p>
          <div className="pt-1">
            <a
              href="https://reportaproblem.apple.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-bold text-xs hover:opacity-90 transition-opacity"
            >
              <span>بوابة الإبلاغ عن مشكلة واسترداد الأموال من Apple</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      ),
      answerEn: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            All financial transactions and in-app billing are managed exclusively by the official app stores (Apple App Store / Google Play) under their terms and conditions.
          </p>
          <p>
            Our team never accesses your financial data and cannot directly initiate store refunds. To submit a refund request, visit Apple’s official portal:
          </p>
          <div className="pt-1">
            <a
              href="https://reportaproblem.apple.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-bold text-xs hover:opacity-90 transition-opacity"
            >
              <span>Apple Problem Reporting & Refund Portal</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      )
    },
    {
      id: 'account-auth',
      questionAr: 'تسجيل الدخول وإعداد حساب الطالب (Student Account & Sign In)',
      questionEn: 'Student account setup and credentials',
      answerAr: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            تُنشأ حسابات الطلبة عادةً من قِبل ممثلي المراحل أو المشرفين الأكاديميين لضمان ربط كل طالب بمرحلته ومواده الخاصة.
          </p>
          <p>
            إذا لم تمتلك حساباً بعد، يمكنك تقديم طلب تسجيل من شاشة الدخول. وفي حال نسيت كلمة المرور الخاصة بك أو واجهت مشكلة في الدخول، يمكنك التواصل مع ممثل مرحلتك أو مراسلتنا عبر النموذج أدناه.
          </p>
        </div>
      ),
      answerEn: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            Student accounts are organized by stage representatives or academic moderators to connect each student with their specific curriculum.
          </p>
          <p>
            If you do not have an account yet, you can submit a registration request on the login screen. For password resets or sign-in difficulties, contact your stage rep or message us using the form below.
          </p>
        </div>
      )
    },
    {
      id: 'offline-sync',
      questionAr: 'الوصول دون إنترنت ومزامنة الاختبارات (Offline Access & Sync)',
      questionEn: 'Offline reading, downloads, and quiz synchronization',
      answerAr: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            يتيح تطبيق «محاضراتي» تحميل ملفات المحاضرات وحفظها في التنزيلات لدراستها في أي وقت دون اتصال بالإنترنت.
          </p>
          <p>
            بالنسبة للاختبارات التفاعلية (MCQs): إذا فقدت الاتصال، يقوم التطبيق بحفظ إجاباتك محلياً بشكل آمن، وتتم إعادة مزامنتها تلقائياً مع السيرفر بمجرد عودة الاتصال.
          </p>
        </div>
      ),
      answerEn: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            The MyLecture app lets you download lecture files to local storage for offline reading anytime.
          </p>
          <p>
            For interactive quizzes (MCQs): If connectivity drops, your responses are securely cached locally and automatically synchronized with the server as soon as the connection is restored.
          </p>
        </div>
      )
    },
    {
      id: 'errata-report',
      questionAr: 'الإبلاغ عن تصحيح علمي أو خطأ في الأسئلة (Scientific Errata)',
      questionEn: 'Reporting scientific errata or quiz question corrections',
      answerAr: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            نحرص على أعلى درجات الدقة العلمية للمحتوى. إذا وجدت خطأ في صياغة سؤال أو إجابة نموذجية:
          </p>
          <ul className="list-disc list-inside space-y-1 ps-1 text-slate-800 dark:text-stone-200">
            <li>يمكنك الضغط على زر الإبلاغ عن السؤال مباشرة من شاشة مراجعة الاختبار داخل التطبيق.</li>
            <li>أو مراسلتنا بتفاصيل الخطأ عبر النموذج أدناه باختيار تصنيف «تصحيح علمي».</li>
          </ul>
        </div>
      ),
      answerEn: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            We strive for academic accuracy. If you notice an error in a quiz question or answer:
          </p>
          <ul className="list-disc list-inside space-y-1 ps-1 text-slate-800 dark:text-stone-200">
            <li>Use the in-quiz flag button directly on the review screen.</li>
            <li>Or submit the details through the contact form below under “Scientific Correction”.</li>
          </ul>
        </div>
      )
    }
  ];

  return (
    <LegalShell
      lang={lang}
      setLang={setLang}
      title={isRtl ? 'مركز المساعدة والدعم الفني' : 'Help & Support Center'}
      updated={isRtl ? 'آخر تحديث: ٢٨ أيلول ٢٠٢٦' : 'Last updated: 28 September 2026'}
    >
      {/* Intro paragraph */}
      <p className="text-slate-600 dark:text-slate-300">
        {isRtl
          ? 'نحن هنا لمساعدتكم في كل ما يخص إدارة الحساب، استعادة وتجديد الاشتراكات، الاستفسارات التقنية، وتلقي ملاحظاتكم وتصحيحاتكم العلمية لخدمة الطلبة.'
          : 'We are here to assist with student account management, subscription restoration and renewals, technical inquiries, and academic feedback.'}
      </p>

      {/* 1. DIRECT SUPPORT SECTION */}
      <Section heading={isRtl ? 'التواصل المباشر مع فريق الدعم' : 'Direct Support & Contact'}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
          {/* Email Info Card (1/3) */}
          <div className="p-4 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 flex flex-col justify-between shadow-xs">
            <div className="space-y-3">
              <div className="w-9 h-9 rounded-xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center border border-sky-100 dark:border-sky-900/50">
                <Mail className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-slate-900 dark:text-stone-100">
                  {isRtl ? 'البريد الإلكتروني المعتمد' : 'Official Support Email'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {isRtl ? 'راسلنا مباشرة في أي وقت:' : 'Write to us directly:'}
                </p>
              </div>

              <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800/70 border border-slate-200 dark:border-zinc-700/80">
                <div className="flex items-center justify-between gap-1">
                  <span dir="ltr" className="font-mono text-xs font-bold text-sky-600 dark:text-sky-400 truncate select-all">
                    {SUPPORT_EMAIL}
                  </span>
                  <button
                    onClick={handleCopyEmail}
                    type="button"
                    title={isRtl ? 'نسخ البريد' : 'Copy email'}
                    className="p-1 rounded-md hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-500 dark:text-slate-400 transition-colors"
                  >
                    {copiedEmail ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 p-2 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-emerald-800 dark:text-emerald-300 text-[11px] font-bold">
                <Clock className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span>{isRtl ? 'الرد خلال 24 ساعة عمل' : 'Response within 24h SLA'}</span>
              </div>
            </div>

            <div className="pt-4">
              <a
                href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(isRtl ? 'استفسار دعم محاضراتي' : 'MyLecture Support Inquiry')}`}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs transition-colors shadow-xs"
              >
                <Mail className="w-3.5 h-3.5" />
                <span>{isRtl ? 'إرسال بريد الآن' : 'Send Email Now'}</span>
              </a>
            </div>
          </div>

          {/* Quick Inquiry Form (2/3) */}
          <div className="md:col-span-2 p-5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xs">
            <h3 className="font-bold text-sm text-slate-900 dark:text-stone-100 mb-1">
              {isRtl ? 'إرسال استفسار فوري' : 'Submit Quick Inquiry'}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              {isRtl ? 'املأ النموذج أدناه وسيصل طلبك مباشرة لفريق الدعم:' : 'Fill in the form to reach our support team directly:'}
            </p>

            {formSubmitted ? (
              <div className="p-4 rounded-xl bg-emerald-50/80 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-center space-y-3">
                <div className="w-9 h-9 rounded-full bg-emerald-100 dark:bg-emerald-900/60 text-emerald-600 dark:text-emerald-300 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-emerald-900 dark:text-emerald-200 mb-0.5">
                    {isRtl ? 'تم استلام استفسارك بنجاح' : 'Inquiry Received Successfully'}
                  </h4>
                  <p className="text-xs text-emerald-800 dark:text-emerald-300">
                    {isRtl ? 'رقم التذكرة:' : 'Ticket ID:'}{' '}
                    <strong className="font-mono underline">{ticketId}</strong>
                  </p>
                </div>
                <div className="pt-1 flex flex-wrap justify-center gap-2">
                  <button
                    onClick={() => {
                      setFormSubmitted(false);
                      setFormName('');
                      setFormEmail('');
                      setFormMessage('');
                      setSubmitError(null);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition-colors cursor-pointer"
                  >
                    {isRtl ? 'إرسال استفسار آخر' : 'Send Another'}
                  </button>
                  <a
                    href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(isRtl ? `متابعة تذكرة دعم ${ticketId}` : `Follow-up Support Ticket ${ticketId}`)}&body=${encodeURIComponent(isRtl ? `رقم التذكرة: ${ticketId}\nالاسم: ${formName}\nالرسالة: ${formMessage}` : `Ticket ID: ${ticketId}\nName: ${formName}\nMessage: ${formMessage}`)}`}
                    className="px-3 py-1.5 rounded-lg bg-white dark:bg-zinc-800 border border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-300 font-bold text-xs transition-colors inline-flex items-center gap-1.5"
                  >
                    <Mail className="w-3.5 h-3.5" />
                    <span>{isRtl ? 'متابعة عبر البريد' : 'Follow up via Email'}</span>
                  </a>
                </div>
              </div>
            ) : (
              <form onSubmit={handleFormSubmit} noValidate className="space-y-3">
                {submitError && (
                  <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-xs flex flex-wrap items-center justify-between gap-2">
                    <span>{submitError}</span>
                    <a
                      href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(isRtl ? 'استفسار دعم فوري' : 'Direct Support Inquiry')}&body=${encodeURIComponent(formMessage)}`}
                      className="underline font-bold text-rose-800 dark:text-rose-200"
                    >
                      {isRtl ? 'فتح تطبيق البريد' : 'Open Mail Client'}
                    </a>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="support-name" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                      {isRtl ? 'الاسم الكامل' : 'Full Name'} <span className="text-rose-500">*</span>
                    </label>
                    <input
                      id="support-name"
                      type="text"
                      value={formName}
                      onChange={e => {
                        setFormName(e.target.value);
                        if (formErrors.name) setFormErrors(prev => ({ ...prev, name: undefined }));
                      }}
                      placeholder={isRtl ? 'أدخل اسمك الثلاثي' : 'Your name'}
                      className={`w-full px-3 py-2 rounded-xl border text-xs outline-hidden transition-colors bg-slate-50 dark:bg-zinc-800/50 text-slate-900 dark:text-stone-100 ${
                        formErrors.name
                          ? 'border-rose-400 bg-rose-50/20'
                          : 'border-slate-200 dark:border-zinc-700 focus:border-sky-500 focus:bg-white dark:focus:bg-zinc-800'
                      }`}
                    />
                    {formErrors.name && (
                      <p className="mt-1 text-[11px] text-rose-500 flex items-center gap-1 font-medium">
                        <AlertCircle className="w-3 h-3" />
                        <span>{formErrors.name}</span>
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="support-email" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                      {isRtl ? 'البريد الإلكتروني للرد' : 'Email Address'} <span className="text-rose-500">*</span>
                    </label>
                    <input
                      id="support-email"
                      dir="ltr"
                      type="email"
                      value={formEmail}
                      onChange={e => {
                        setFormEmail(e.target.value);
                        if (formErrors.email) setFormErrors(prev => ({ ...prev, email: undefined }));
                      }}
                      placeholder="student@example.com"
                      className={`w-full px-3 py-2 rounded-xl border text-xs outline-hidden transition-colors bg-slate-50 dark:bg-zinc-800/50 text-slate-900 dark:text-stone-100 ${
                        formErrors.email
                          ? 'border-rose-400 bg-rose-50/20'
                          : 'border-slate-200 dark:border-zinc-700 focus:border-sky-500 focus:bg-white dark:focus:bg-zinc-800'
                      }`}
                    />
                    {formErrors.email && (
                      <p className="mt-1 text-[11px] text-rose-500 flex items-center gap-1 font-medium">
                        <AlertCircle className="w-3 h-3" />
                        <span>{formErrors.email}</span>
                      </p>
                    )}
                  </div>
                </div>

                <div>
                  <label htmlFor="support-category" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    {isRtl ? 'نوع الاستفسار' : 'Inquiry Category'}
                  </label>
                  <select
                    id="support-category"
                    value={formCategory}
                    onChange={e => setFormCategory(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 text-xs outline-hidden bg-slate-50 dark:bg-zinc-800/50 text-slate-900 dark:text-stone-100 focus:border-sky-500 focus:bg-white dark:focus:bg-zinc-800 transition-colors"
                  >
                    <option value="subscription">{isRtl ? 'الاشتراكات واستعادة المشتريات' : 'Subscriptions & In-App Purchases'}</option>
                    <option value="account">{isRtl ? 'الحساب وتسجيل الدخول' : 'Account & Login'}</option>
                    <option value="sync">{isRtl ? 'التحميل والمزامنة دون إنترنت' : 'Offline Access & Sync'}</option>
                    <option value="errata">{isRtl ? 'تصحيح علمي أو ملاحظة على الأسئلة' : 'Scientific Correction'}</option>
                    <option value="general">{isRtl ? 'استفسار عام' : 'General Inquiry'}</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="support-message" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    {isRtl ? 'تفاصيل الرسالة' : 'Message'} <span className="text-rose-500">*</span>
                  </label>
                  <textarea
                    id="support-message"
                    rows={3}
                    value={formMessage}
                    onChange={e => {
                      setFormMessage(e.target.value);
                      if (formErrors.message) setFormErrors(prev => ({ ...prev, message: undefined }));
                    }}
                    placeholder={isRtl ? 'اكتب تفاصيل استفسارك مع ذكر المرحلة الدراسية...' : 'Describe your inquiry or issue...'}
                    className={`w-full px-3 py-2 rounded-xl border text-xs outline-hidden resize-none transition-colors bg-slate-50 dark:bg-zinc-800/50 text-slate-900 dark:text-stone-100 ${
                      formErrors.message
                        ? 'border-rose-400 bg-rose-50/20'
                        : 'border-slate-200 dark:border-zinc-700 focus:border-sky-500 focus:bg-white dark:focus:bg-zinc-800'
                    }`}
                  />
                  {formErrors.message && (
                    <p className="mt-1 text-[11px] text-rose-500 flex items-center gap-1 font-medium">
                      <AlertCircle className="w-3 h-3" />
                      <span>{formErrors.message}</span>
                    </p>
                  )}
                </div>

                <div className="pt-1 flex justify-end">
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-bold text-xs shadow-xs transition-colors cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>{isSubmitting ? (isRtl ? 'جارٍ الإرسال...' : 'Sending...') : (isRtl ? 'إرسال الاستفسار' : 'Submit Inquiry')}</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </Section>

      {/* 2. IN-APP PURCHASES & SUBSCRIPTIONS SECTION */}
      <Section heading={isRtl ? 'الاشتراكات وعمليات الشراء داخل التطبيق' : 'App Store Subscriptions & Purchases'}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          {/* Card 1 */}
          <div className="p-4 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 space-y-2 shadow-xs">
            <div className="w-8 h-8 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center">
              <RotateCcw className="w-4 h-4" />
            </div>
            <h4 className="font-bold text-sm text-slate-900 dark:text-stone-100">
              {isRtl ? 'استعادة المشتريات' : 'Restore Purchases'}
            </h4>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {isRtl
                ? 'عند تغيير الجهاز أو إعادة تثبيت التطبيق، اضغط زر «استعادة المشتريات» بشاشة الاشتراك ليتم تفعيل باقتك فوراً دون دفع.'
                : 'On new devices or reinstalls, tap “Restore Purchases” on the subscription screen to reactivate your features.'}
            </p>
          </div>

          {/* Card 2 */}
          <div className="p-4 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 space-y-2 shadow-xs">
            <div className="w-8 h-8 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center">
              <Clock className="w-4 h-4" />
            </div>
            <h4 className="font-bold text-sm text-slate-900 dark:text-stone-100">
              {isRtl ? 'إلغاء التجديد التلقائي' : 'Auto-Renewal & Cancel'}
            </h4>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {isRtl
                ? 'يتم التجديد تلقائياً ما لم يتم الإلغاء قبل 24 ساعة من نهاية الفترة عبر: إعدادات الجهاز ← Apple ID ← الاشتراكات.'
                : 'Subscriptions auto-renew unless cancelled at least 24h prior via: Device Settings → Apple ID → Subscriptions.'}
            </p>
          </div>

          {/* Card 3 */}
          <div className="p-4 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 space-y-2 shadow-xs">
            <div className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <CreditCard className="w-4 h-4" />
            </div>
            <h4 className="font-bold text-sm text-slate-900 dark:text-stone-100">
              {isRtl ? 'سياسة الاسترداد والفوترة' : 'Refunds & Store Billing'}
            </h4>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {isRtl ? (
                <>
                  تُدار المدفوعات حصرياً من قِبل Apple. لطلب استرداد أي مبلغ، تفضل بزيارة{' '}
                  <a href="https://reportaproblem.apple.com" target="_blank" rel="noopener noreferrer" className="text-sky-600 dark:text-sky-400 font-semibold hover:underline">
                    reportaproblem.apple.com
                  </a>.
                </>
              ) : (
                <>
                  Billing is governed exclusively by Apple. To request a refund, visit{' '}
                  <a href="https://reportaproblem.apple.com" target="_blank" rel="noopener noreferrer" className="text-sky-600 dark:text-sky-400 font-semibold hover:underline">
                    reportaproblem.apple.com
                  </a>.
                </>
              )}
            </p>
          </div>
        </div>
      </Section>

      {/* 3. FREQUENTLY ASKED QUESTIONS SECTION */}
      <Section heading={isRtl ? 'الأسئلة الشائعة والأكاديمية' : 'Frequently Asked Questions'}>
        <div className="space-y-2 pt-1">
          {faqItems.map((item) => {
            const isOpen = openAccordion === item.id;
            return (
              <div
                key={item.id}
                className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs transition-colors"
              >
                <button
                  type="button"
                  onClick={() => toggleFaq(item.id)}
                  aria-expanded={isOpen}
                  className="w-full px-4 py-3 flex items-center justify-between gap-3 text-start hover:bg-slate-50/70 dark:hover:bg-zinc-800/40 transition-colors cursor-pointer"
                >
                  <span className="text-sm font-bold text-slate-900 dark:text-stone-100">
                    {isRtl ? item.questionAr : item.questionEn}
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
                      isOpen ? 'rotate-180 text-sky-600 dark:text-sky-400' : ''
                    }`}
                  />
                </button>

                {isOpen && (
                  <div className="px-4 pb-4 pt-1 text-slate-600 dark:text-slate-300 border-t border-slate-100 dark:border-zinc-800/60">
                    {isRtl ? item.answerAr : item.answerEn}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>
    </LegalShell>
  );
}
