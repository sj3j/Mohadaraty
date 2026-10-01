import './lib/pdfPolyfills';
import { logPerfMark } from './lib/perf';

logPerfMark('main-started');

if (import.meta.env.VITE_ENABLE_VCONSOLE === 'true' || import.meta.env.VITE_DEBUG === '1') {
  import('vconsole').then(({ default: VConsole }) => {
    new VConsole();
    logPerfMark('vconsole-mounted');
  }).catch((err) => {
    console.error('Failed to load vconsole', err);
  });
}

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import './index.css';
import { registerSW } from 'virtual:pwa-register';
import { AudioProvider } from './contexts/AudioContext';
import { StageProvider } from './contexts/StageContext';

const originalConsoleError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('Detected an update time that is in the future')) return;
  originalConsoleError.apply(console, args);
};

const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('Detected an update time that is in the future')) return;
  originalConsoleWarn.apply(console, args);
};

// Register PWA Service Worker
if ('serviceWorker' in navigator) {
  registerSW({ immediate: true });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <StageProvider>
        <AudioProvider>
          <App />
        </AudioProvider>
      </StageProvider>
    </ErrorBoundary>
  </StrictMode>,
);
