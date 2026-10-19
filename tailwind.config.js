/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        tajawal: ['Tajawal', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      animation: {
        'horizon-shimmer': 'slowDiagonalHorizonShimmer 6s cubic-bezier(0.4, 0, 0.2, 1) infinite',
      },
      keyframes: {
        slowDiagonalHorizonShimmer: {
          '0%': { transform: 'translateX(-150%) skewX(-20deg)', opacity: '0' },
          '8%': { opacity: '1' },
          '34%': { transform: 'translateX(250%) skewX(-20deg)', opacity: '0.95' },
          '35%, 100%': { transform: 'translateX(250%) skewX(-20deg)', opacity: '0' },
        },
      },
    },
  },
  plugins: [
    // tailwindcss-animate provides animate-in, fade-in, zoom-in, slide-in utilities
    require('tailwindcss-animate'),
  ],
};
