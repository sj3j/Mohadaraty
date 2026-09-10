import { useCallback, useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import {
  DEFAULT_TELEGRAM_CONFIG,
  coerceTelegramConfig,
  type TelegramConfig,
} from '../../shared/telegramMirror';

/**
 * The Telegram channel map, and the mirror bot's self-reported health.
 *
 * Both documents are master-admin-only to READ, not merely to write - they name
 * the private channel ids of all five stages. So unlike useAcademicPhase, a
 * permission-denied here is the expected outcome for almost every caller and is
 * swallowed silently; only the master admin's settings screen ever mounts this.
 *
 * The status document is written by the bot through the Admin SDK and is
 * read-only from the client. Its `updatedAt` is a heartbeat: the UI calls the
 * bot offline when it goes stale rather than trusting a stored "running" flag,
 * because a container that was SIGKILLed never got to write one.
 */

export interface TelegramChannelStatus {
  chatId?: number;
  title?: string;
  adminOk?: boolean;
  missingRights?: string[];
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  inbound24h?: number;
  outbound24h?: number;
  state?: 'ok' | 'degraded' | 'parked';
  lastError?: string | null;
  lastErrorAt?: string | null;
}

export interface TelegramStatus {
  instanceId?: string;
  bootedAt?: string;
  version?: string;
  updatedAt?: string;
  pollState?: 'polling' | 'backoff' | 'stalled';
  lastUpdateId?: number;
  lastBatchAt?: string;
  configError?: string | null;
  channels?: Record<string, TelegramChannelStatus>;
  counters24h?: Record<string, number>;
}

/** A heartbeat older than this means nothing is running. Two minutes is four
 *  missed 30s status writes - long enough to ride out a restart, short enough
 *  that a dead bot is not reported as healthy through a lecture. */
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;

export function useTelegramMirror() {
  const [config, setConfig] = useState<TelegramConfig>(DEFAULT_TELEGRAM_CONFIG);
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const unsubConfig = onSnapshot(
      doc(db, 'admin_config', 'telegram'),
      snap => {
        setConfig(snap.exists() ? coerceTelegramConfig(snap.data()) : DEFAULT_TELEGRAM_CONFIG);
        setLoadError(null);
        setIsLoading(false);
      },
      err => {
        // Anyone but a master admin is denied by design, and there is nothing
        // to show them. Surface it only so the screen can say so plainly
        // instead of rendering an empty, apparently-unconfigured form.
        setConfig(DEFAULT_TELEGRAM_CONFIG);
        setLoadError(err?.code === 'permission-denied' ? 'denied' : 'error');
        setIsLoading(false);
      },
    );

    const unsubStatus = onSnapshot(
      doc(db, 'admin_config', 'telegram_status'),
      snap => setStatus(snap.exists() ? (snap.data() as TelegramStatus) : null),
      () => setStatus(null),
    );

    return () => { unsubConfig(); unsubStatus(); };
  }, []);

  const saveConfig = useCallback(async (next: TelegramConfig, actorEmail?: string) => {
    // merge:false, like saveCalendar: removing a stage's channel has to actually
    // remove it, and a merge would leave the old chatId in place forever.
    await setDoc(doc(db, 'admin_config', 'telegram'), {
      enabled: next.enabled,
      channels: next.channels,
      defaultMirrorOut: next.defaultMirrorOut,
      updatedAt: new Date().toISOString(),
      updatedBy: actorEmail ?? null,
    }, { merge: false });
  }, []);

  const heartbeatAge = status?.updatedAt ? Date.now() - Date.parse(status.updatedAt) : Infinity;
  const isBotOnline = Number.isFinite(heartbeatAge) && heartbeatAge < HEARTBEAT_STALE_MS;

  return { config, status, isBotOnline, isLoading, loadError, saveConfig };
}
