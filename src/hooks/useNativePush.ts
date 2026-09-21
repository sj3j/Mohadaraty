import { useEffect, useState } from 'react';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { UserProfile } from '../types';

/**
 * Push notifications for the Capacitor build.
 *
 * The existing usePushNotifications hook uses firebase/messaging, which is WEB
 * push - a service worker plus the Push API. Neither exists inside an Android
 * WebView, so on the installed app that hook silently registers nothing and no
 * notification ever arrives. Native builds have to go through the OS via
 * @capacitor/push-notifications and FCM's Android SDK instead.
 *
 * The token has to land in BOTH places, because two different senders read two
 * different locations:
 *
 *   - `fcm_tokens/{uid}` is what every Cloud Function sender reads
 *     (functions/index.js getTokensWithPreferences) - lectures, announcements
 *     and homework all fan out from there. This is also where the web path
 *     writes (usePushNotifications).
 *   - `users/{uid}.fcmToken` is what /api/cron/streak-warnings reads.
 *
 * This hook used to write only the second one, with a comment claiming it was
 * "the same field the web path writes". It is not, and the consequence was that
 * the installed Android app registered a token no content sender ever looked at,
 * so lecture/announcement/homework notifications never arrived on the APK.
 *
 * The plugin is imported dynamically so the web bundle never pulls it in.
 */
export function useNativePush(user: UserProfile | null) {
  const [token, setToken] = useState<string | null>(null);
  const [permission, setPermission] = useState<'prompt' | 'granted' | 'denied'>('prompt');

  useEffect(() => {
    if (!user?.uid) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      let Capacitor: any, PushNotifications: any;
      try {
        ({ Capacitor } = await import('@capacitor/core'));
        if (!Capacitor?.isNativePlatform?.()) return; // web handles itself
        ({ PushNotifications } = await import('@capacitor/push-notifications'));
      } catch {
        return; // plugin absent - web build
      }

      try {
        // Android 13+ requires a runtime prompt; below that this resolves granted.
        let perm = await PushNotifications.checkPermissions();
        if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
          perm = await PushNotifications.requestPermissions();
        }
        if (cancelled) return;

        if (perm.receive !== 'granted') {
          setPermission('denied');
          return;
        }
        setPermission('granted');

        const onReg = await PushNotifications.addListener('registration', async (t: { value: string }) => {
          if (cancelled) return;
          setToken(t.value);

          // WHAT THIS TOKEN ACTUALLY IS, PER PLATFORM
          //
          // @capacitor/push-notifications returns whatever the OS hands back.
          // On Android that is an FCM registration token, which is what every
          // sender in functions/index.js expects. On iOS it is a raw APNs
          // device token - the plugin calls registerForRemoteNotifications and
          // has no Firebase dependency at all - and an APNs token is NOT an FCM
          // token.
          //
          // Writing it to fcm_tokens anyway is worse than useless, because that
          // document is ONE PER USER and the senders prune on failure:
          // functions/index.js deletes fcm_tokens/{uid} on
          // messaging/registration-token-not-registered. So a student who
          // installs the iOS app would overwrite the FCM token their Android
          // phone registered, every send would fail, and the delete would then
          // take the working Android token with it - turning "iOS push does not
          // work yet" into "this student gets no notifications on any device".
          //
          // Until iOS gets a real FCM token (@capacitor-firebase/messaging, plus
          // an APNs auth key uploaded to Firebase and the Push Notifications
          // capability on the target), iOS registers with the OS - so the
          // permission prompt and foreground listeners still behave - but
          // publishes nothing a sender would try to use.
          const platform = Capacitor.getPlatform?.() ?? 'android';
          if (platform !== 'android') {
            console.warn(
              `[push] ${platform}: got an OS push token that is not an FCM token; ` +
              'not publishing it. See CLAUDE.md, "iOS push needs a real FCM token".',
            );
            return;
          }

          // Written separately, not in a batch: the users doc is subject to the
          // self-edit rules and can legitimately be refused, and that must not
          // stop the fcm_tokens write, which is the one content delivery needs.
          try {
            await setDoc(doc(db, 'fcm_tokens', user.uid), {
              token: t.value,
              platform,
              updatedAt: serverTimestamp(),
            }, { merge: true });
          } catch (err) {
            console.error('Failed to save push token to fcm_tokens:', err);
          }

          try {
            await setDoc(doc(db, 'users', user.uid), {
              fcmToken: t.value,
              fcmPlatform: platform,
              fcmUpdatedAt: new Date().toISOString(),
            }, { merge: true });
          } catch (err) {
            console.error('Failed to mirror push token onto the user doc:', err);
          }
        });

        const onErr = await PushNotifications.addListener('registrationError', (err: any) => {
          console.error('Push registration failed:', err);
        });

        await PushNotifications.register();

        cleanup = () => { onReg.remove?.(); onErr.remove?.(); };
      } catch (err) {
        console.error('Native push setup failed:', err);
      }
    })();

    return () => { cancelled = true; cleanup?.(); };
  }, [user?.uid]);

  return { token, permission };
}
