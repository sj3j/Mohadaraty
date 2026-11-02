import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCw, Database } from 'lucide-react';
import {
  isFirestoreAssertionError,
  hasRecentlyAttemptedRecovery,
  recoverCorruptedFirestoreCache
} from '../lib/firestoreRecovery';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  isRecovering: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    isRecovering: false,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    const isAssertion = isFirestoreAssertionError(error);
    const recentlyAttempted = hasRecentlyAttemptedRecovery();
    return {
      hasError: true,
      error,
      isRecovering: isAssertion && !recentlyAttempted,
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);

    if (isFirestoreAssertionError(error)) {
      if (!hasRecentlyAttemptedRecovery()) {
        this.setState({ isRecovering: true });
        void recoverCorruptedFirestoreCache(false);
      }
    }
  }

  private handleManualReset = async () => {
    this.setState({ isRecovering: true });
    await recoverCorruptedFirestoreCache(true);
  };

  public render() {
    if (this.state.hasError) {
      if (this.state.isRecovering) {
        return (
          <div className="min-h-screen bg-slate-50 dark:bg-zinc-900 flex items-center justify-center p-4" dir="rtl">
            <div className="bg-white dark:bg-zinc-800 p-8 rounded-3xl shadow-xl max-w-md w-full text-center border border-slate-200 dark:border-zinc-700">
              <div className="w-16 h-16 bg-sky-100 dark:bg-sky-900/30 rounded-full flex items-center justify-center mx-auto mb-6 animate-pulse">
                <Database className="w-8 h-8 text-sky-600 dark:text-sky-400 animate-spin" />
              </div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-stone-100 mb-3">
                جاري معالجة الذاكرة المؤقتة...
              </h1>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-4 leading-relaxed">
                تم اكتشاف تعارض في الذاكرة المؤقتة لقاعدة البيانات. نقوم الآن بتنظيف الذاكرة المحلية وإعادة تشغيل التطبيق تلقائياً.
              </p>
              <p className="text-xs text-slate-400 dark:text-slate-500 font-mono">
                Recovering local cache & reloading...
              </p>
            </div>
          </div>
        );
      }

      // Try to parse the error message if it's our custom JSON format
      let errorMessage = 'An unexpected error occurred.';
      let isPermissionError = false;
      const isAssertion = isFirestoreAssertionError(this.state.error);

      try {
        if (this.state.error?.message) {
          const parsed = JSON.parse(this.state.error.message);
          if (parsed.error && parsed.error.includes('permission-denied')) {
            isPermissionError = true;
            errorMessage = 'You do not have permission to access this data. Please check your account role or contact an administrator.';
          } else if (parsed.error) {
            errorMessage = parsed.error;
          }
        }
      } catch (e) {
        // Not a JSON error string, use the original message or fallback
        errorMessage = this.state.error?.message || errorMessage;
      }

      return (
        <div className="min-h-screen bg-slate-50 dark:bg-zinc-900 flex items-center justify-center p-4" dir="auto">
          <div className="bg-white dark:bg-zinc-800 p-8 rounded-3xl shadow-xl max-w-md w-full text-center border border-slate-200 dark:border-zinc-700">
            <div className="w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
              <AlertCircle className="w-8 h-8 text-red-600 dark:text-red-400" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-stone-100 mb-4">
              Oops! Something went wrong
            </h1>
            <p className="text-slate-600 dark:text-slate-400 mb-6 leading-relaxed text-sm">
              {errorMessage}
            </p>
            <div className="flex flex-col gap-3">
              {isAssertion && (
                <button
                  onClick={this.handleManualReset}
                  className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-bold transition-colors shadow-sm"
                >
                  <Database className="w-5 h-5" />
                  مسح الذاكرة التالفة وإعادة المحاولة
                </button>
              )}
              <button
                onClick={() => window.location.reload()}
                className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-sky-600 hover:bg-sky-700 text-white rounded-xl font-bold transition-colors"
              >
                <RefreshCw className="w-5 h-5" />
                Reload Application
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (this as any).props.children;
  }
}
