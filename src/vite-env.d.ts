/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_VCONSOLE: string;
  readonly VITE_PDF_STABLE_INTERACTION_ROUTING?: string;
  readonly VITE_PDF_NATIVE_INK_V2?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module 'arabic-persian-reshaper' {
  export function convertArabic(text: string): string;
  export function convertArabicBack(text: string): string;
  export const ArabicShaper: {
    convertArabic: (text: string) => string;
    convertArabicBack: (text: string) => string;
  };
  export const PersianShaper: {
    convertArabic: (text: string) => string;
    convertArabicBack: (text: string) => string;
  };
  const defaultExport: {
    convertArabic?: (text: string) => string;
    ArabicShaper?: {
      convertArabic: (text: string) => string;
    };
    PersianShaper?: typeof PersianShaper;
  };
  export default defaultExport;
}

declare module '@pdf-lib/fontkit';

