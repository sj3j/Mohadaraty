import { useCallback, useEffect, useRef, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { IS_MACOS_BUILD, IS_STORE_BUILD } from '../lib/platform';
import {
  DEFAULT_MOBILE_RELEASE_POLICY,
  evaluateUpdateRequirement,
  normalizeMobileReleasePolicy,
  parseNativeBuild,
  type MobileReleasePlatform,
  type UpdateRequirement,
} from '../lib/mobileReleasePolicy';

const OPEN_GATE: UpdateRequirement = {
  required: false,
  platform: null,
  installedBuild: null,
  minBuild: null,
  storeUrl: '',
};

export interface MobileReleaseGate extends UpdateRequirement {
  retry: () => void;
}

/**
 * A cached Firestore snapshot never starts a block. Once this process receives
 * a server-confirmed policy, its live listener may enforce or remove the gate.
 */
export function useMobileReleaseGate(
  role: string | null | undefined,
  authenticatedUid: string | null,
): MobileReleaseGate {
  const [requirement, setRequirement] = useState<UpdateRequirement>(OPEN_GATE);
  const [retryToken, setRetryToken] = useState(0);
  const retry = useCallback(() => setRetryToken(value => value + 1), []);
  const currentRef = useRef<UpdateRequirement>(OPEN_GATE);

  useEffect(() => {
    currentRef.current = requirement;
  }, [requirement]);

  useEffect(() => {
    if (role !== 'student' || !authenticatedUid || !IS_STORE_BUILD || IS_MACOS_BUILD) {
      setRequirement(OPEN_GATE);
      return;
    }

    let cancelled = false;
    let removeAppListener: (() => void) | null = null;
    let unsubscribePolicy: (() => void) | null = null;

    const start = async () => {
      try {
        const [{ Capacitor }, { App }] = await Promise.all([
          import('@capacitor/core'),
          import('@capacitor/app'),
        ]);
        if (cancelled || !Capacitor.isNativePlatform()) {
          if (!cancelled) setRequirement(OPEN_GATE);
          return;
        }

        const nativePlatform = Capacitor.getPlatform();
        const platform: MobileReleasePlatform | null =
          nativePlatform === 'android' || nativePlatform === 'ios' ? nativePlatform : null;
        const info = await App.getInfo();
        const installedBuild = parseNativeBuild(info.build);
        if (cancelled || !platform) return;

        unsubscribePolicy = onSnapshot(
          doc(db, 'app_settings', 'mobileReleasePolicy'),
          { includeMetadataChanges: true },
          snapshot => {
            if (cancelled || snapshot.metadata.fromCache) return;
            const policy = snapshot.exists()
              ? normalizeMobileReleasePolicy(snapshot.data())
              : DEFAULT_MOBILE_RELEASE_POLICY;
            setRequirement(evaluateUpdateRequirement({
              policy,
              platform,
              installedBuild,
              role,
              isNative: true,
              isFresh: true,
            }));
          },
          error => {
            // Fail open when this launch has not received a fresh policy. If a
            // policy was already verified, retain it until a server update.
            if (!cancelled && !currentRef.current.required) setRequirement(OPEN_GATE);
            if (error?.code !== 'unavailable') {
              console.warn('[mobile-release] policy listener failed', error);
            }
          },
        );

        const handle = await App.addListener('appStateChange', state => {
          if (state.isActive) retry();
        });
        if (cancelled) handle.remove();
        else removeAppListener = () => { void handle.remove(); };
      } catch (error) {
        if (!cancelled) setRequirement(OPEN_GATE);
        console.warn('[mobile-release] native version check failed open', error);
      }
    };

    void start();
    const onOnline = () => retry();
    window.addEventListener('online', onOnline);

    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      unsubscribePolicy?.();
      removeAppListener?.();
    };
  }, [authenticatedUid, role, retry, retryToken]);

  return { ...requirement, retry };
}
