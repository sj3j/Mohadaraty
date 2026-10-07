import React from 'react';
import { Sun, Moon, Smartphone, Circle, Check, Crown } from 'lucide-react';
import { Language, UserProfile } from '../../types';
import { ThemeChoice } from '../../hooks/useTheme';
import { useSubscriptionBannerTheme } from '../../hooks/useSubscriptionBannerTheme';

const OPTIONS: { id: ThemeChoice; ar: string; en: string; sub: { ar: string; en: string }; Icon: any }[] = [
  { id: 'system', ar: 'حسب النظام', en: 'Match system',
    sub: { ar: 'يتبع إعداد الهاتف تلقائياً', en: 'Follows your phone automatically' }, Icon: Smartphone },
  { id: 'light',  ar: 'فاتح', en: 'Light',
    sub: { ar: 'خلفية بيضاء', en: 'White background' }, Icon: Sun },
  { id: 'dark',   ar: 'داكن', en: 'Dark',
    sub: { ar: 'رمادي داكن مريح للعين', en: 'Soft dark grey' }, Icon: Moon },
  { id: 'black',  ar: 'أسود كامل', en: 'True black',
    sub: { ar: 'موفّر للبطارية على شاشات OLED', en: 'Saves battery on OLED screens' }, Icon: Circle },
];

/** Theme picker. Rendered inside the Appearance settings page. */
export default function AppearanceSettings({
  lang, theme, setTheme, user,
}: {
  lang: Language;
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  user?: UserProfile | null;
}) {
  const isRtl = lang === 'ar';
  const { themeId: bannerThemeId, theme: bannerTheme, changeTheme: changeBannerTheme, allThemes } = useSubscriptionBannerTheme(user);

  return (
    <div className="space-y-6">
      {/* App Interface Theme */}
      <div className="space-y-2">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2 px-1">
          {isRtl ? 'مظهر واجهة التطبيق' : 'App Theme'}
        </div>
        {OPTIONS.map(opt => {
          const active = theme === opt.id;
          return (
            <button
              key={opt.id}
              onClick={() => setTheme(opt.id)}
              className={`w-full flex items-center gap-3 p-3.5 rounded-2xl border-2 transition-all text-start ${
                active
                  ? 'border-sky-500 bg-sky-50 dark:bg-sky-900/20'
                  : 'border-slate-200 dark:border-zinc-800 hover:border-sky-300'
              }`}
            >
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                active ? 'bg-sky-100 dark:bg-sky-900/40' : 'bg-slate-100 dark:bg-zinc-800'
              }`}>
                <opt.Icon className={`w-5 h-5 ${active ? 'text-sky-600 dark:text-sky-400' : 'text-slate-400'}`} strokeWidth={2.5} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-bold text-[15px] text-slate-800 dark:text-slate-100">
                  {isRtl ? opt.ar : opt.en}
                </div>
                <div className="text-xs font-bold text-slate-400 dark:text-slate-500 mt-0.5">
                  {isRtl ? opt.sub.ar : opt.sub.en}
                </div>
              </div>
              {active && <Check className="w-5 h-5 text-sky-500 shrink-0" strokeWidth={3} />}
            </button>
          );
        })}
      </div>

      {/* Subscription Banner Color Customization */}
      <div className="pt-5 border-t border-slate-200 dark:border-zinc-800 space-y-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Crown className="w-4 h-4 text-amber-500" />
            <h3 className="font-bold text-sm text-slate-900 dark:text-white">
              {isRtl ? 'لون بطاقة الاشتراك' : 'Subscription Banner Theme'}
            </h3>
          </div>
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {isRtl
              ? 'اختر المظهر اللوني لبطاقة الاشتراك المميز وحركة الشعاع الضوئي'
              : 'Choose the visual color theme and light shimmer for your subscription card'}
          </p>
        </div>

        {/* Live Preview Card */}
        <div className={`relative overflow-hidden rounded-2xl p-4 border transition-all duration-300 ${bannerTheme.cardBg} ${bannerTheme.cardBorder} ${bannerTheme.shadow}`}>
          {/* Slow Diagonal Horizon Shimmer beam */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div className={`absolute -inset-full w-[250%] h-[250%] bg-gradient-to-r ${bannerTheme.shimmerColor} animate-horizon-shimmer`} />
          </div>

          <div className="relative z-10 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${bannerTheme.iconBg}`}>
                <Crown className="w-5 h-5" />
              </div>
              <div>
                <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider mb-0.5 ${bannerTheme.badgeBg}`}>
                  {isRtl ? 'معاينة حية' : 'Live Preview'}
                </span>
                <h4 className="font-black text-sm leading-tight">
                  {isRtl ? bannerTheme.nameAr : bannerTheme.nameEn}
                </h4>
              </div>
            </div>
            <span className={`text-[11px] font-bold px-2.5 py-1 rounded-lg ${bannerTheme.accentButton}`}>
              {isRtl ? 'مشترك مميز' : 'VIP Member'}
            </span>
          </div>
        </div>

        {/* 4 Theme Options */}
        <div className="grid grid-cols-2 gap-2.5">
          {allThemes.map(t => {
            const active = bannerThemeId === t.id;
            return (
              <button
                key={t.id}
                onClick={() => changeBannerTheme(t.id)}
                className={`relative flex items-center gap-2.5 p-3 rounded-2xl border-2 transition-all text-start overflow-hidden ${
                  active
                    ? 'border-sky-500 bg-sky-50/70 dark:bg-sky-900/25 ring-2 ring-sky-500/20'
                    : 'border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700 bg-white dark:bg-zinc-900/60'
                }`}
              >
                <div className={`w-7 h-7 rounded-lg shadow-inner shrink-0 ${t.swatchPreview}`} />
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-xs text-slate-800 dark:text-slate-100 truncate">
                    {isRtl ? t.nameAr : t.nameEn}
                  </div>
                  <div className="text-[10px] font-medium text-slate-400 dark:text-slate-500 truncate">
                    {t.id === 'gold' && (isRtl ? 'ملكي متوهج' : 'Royal Gold')}
                    {t.id === 'pink' && (isRtl ? 'زهري فاخر' : 'Rose Pink')}
                    {t.id === 'black' && (isRtl ? 'سواد عميق' : 'Obsidian')}
                    {t.id === 'white' && (isRtl ? 'لؤلؤي ناصع' : 'Frost Pearl')}
                  </div>
                </div>
                {active && <Check className="w-4 h-4 text-sky-500 shrink-0" strokeWidth={3} />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

