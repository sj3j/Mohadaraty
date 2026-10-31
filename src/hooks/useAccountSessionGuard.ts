import { useEffect, useRef } from 'react';
import { signOut } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { clearCachedUserProfile, setExplicitLogoutMarker } from '../lib/authPersistence';
import { safeSetStorageItem } from './useAuthWatchdog';
import { isSessionRevokedError, listAccountSessions } from '../services/accountSessionService';

/** Signs a terminated account device out once it next has a network connection. */
export function useAccountSessionGuard(enabled: boolean, onRevoked?: () => void) {
  const handling = useRef(false);

  useEffect(() => {
    if (!enabled) { handling.current = false; return; }
    let cancelled = false;

    const validate = async () => {
      if (cancelled || handling.current || !navigator.onLine || !auth.currentUser) return;
      try { await listAccountSessions(); }
      catch (error) {
        if (!isSessionRevokedError(error) || cancelled) return;
        handling.current = true;
        const uid = auth.currentUser?.uid;
        setExplicitLogoutMarker();
        safeSetStorageItem('wasSignedIn', 'false');
        clearCachedUserProfile(uid);
        await signOut(auth).catch(() => undefined);
        onRevoked?.();
      }
    };

    void validate();
    const interval = window.setInterval(() => void validate(), 2 * 60 * 1000);
    const online = () => void validate();
    const visible = () => { if (document.visibilityState === 'visible') void validate(); };
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled, onRevoked]);
}
