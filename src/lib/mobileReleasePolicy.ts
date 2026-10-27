export type MobileReleasePlatform = 'android' | 'ios';

export interface MobilePlatformReleasePolicy {
  enabled: boolean;
  minBuild: number;
  storeUrl: string;
}

export interface MobileReleasePolicy {
  enforcementEnabled: boolean;
  android: MobilePlatformReleasePolicy;
  ios: MobilePlatformReleasePolicy;
}

export interface UpdateRequirement {
  required: boolean;
  platform: MobileReleasePlatform | null;
  installedBuild: number | null;
  minBuild: number | null;
  storeUrl: string;
}

export const ANDROID_STORE_URL = 'https://play.google.com/store/apps/details?id=com.mohadaraty.app';
export const IOS_STORE_URL = 'https://apps.apple.com/iq/app/id6814124686';

export const DEFAULT_MOBILE_RELEASE_POLICY: MobileReleasePolicy = {
  enforcementEnabled: false,
  android: { enabled: false, minBuild: 1, storeUrl: ANDROID_STORE_URL },
  ios: { enabled: false, minBuild: 1, storeUrl: IOS_STORE_URL },
};

function platformPolicy(
  platform: MobileReleasePlatform,
  value: unknown,
  fallback: MobilePlatformReleasePolicy,
): MobilePlatformReleasePolicy {
  if (!value || typeof value !== 'object') return { ...fallback };
  const source = value as Record<string, unknown>;
  const validMinBuild = Number.isSafeInteger(source.minBuild) && Number(source.minBuild) >= 1;
  const rawStoreUrl = typeof source.storeUrl === 'string' ? source.storeUrl : '';
  const validStoreUrl = isValidStoreUrl(platform, rawStoreUrl);
  return {
    // A remotely malformed platform block always fails open, even when its
    // enabled flag is true. The admin form repairs it with the safe defaults.
    enabled: source.enabled === true && validMinBuild && validStoreUrl,
    minBuild: validMinBuild
      ? Number(source.minBuild)
      : fallback.minBuild,
    storeUrl: validStoreUrl
      ? rawStoreUrl.trim()
      : fallback.storeUrl,
  };
}

/**
 * Firestore is remotely editable, so normalize every field before it reaches
 * either the student gate or the master-admin form. Missing data fails open.
 */
export function normalizeMobileReleasePolicy(value: unknown): MobileReleasePolicy {
  if (!value || typeof value !== 'object') {
    return {
      ...DEFAULT_MOBILE_RELEASE_POLICY,
      android: { ...DEFAULT_MOBILE_RELEASE_POLICY.android },
      ios: { ...DEFAULT_MOBILE_RELEASE_POLICY.ios },
    };
  }

  const source = value as Record<string, unknown>;
  return {
    enforcementEnabled: source.enforcementEnabled === true,
    android: platformPolicy('android', source.android, DEFAULT_MOBILE_RELEASE_POLICY.android),
    ios: platformPolicy('ios', source.ios, DEFAULT_MOBILE_RELEASE_POLICY.ios),
  };
}

export function parseNativeBuild(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const build = Number(value);
  return Number.isSafeInteger(build) && build >= 1 ? build : null;
}

export function isValidStoreUrl(platform: MobileReleasePlatform, value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return platform === 'android'
      ? host === 'play.google.com' && url.pathname.startsWith('/store/apps/details')
      : host === 'apps.apple.com' && /\/app(?:\/[^/]+)?\/id\d+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function evaluateUpdateRequirement(input: {
  policy: MobileReleasePolicy;
  platform: MobileReleasePlatform | null;
  installedBuild: number | null;
  role: string | null | undefined;
  isNative: boolean;
  isFresh: boolean;
}): UpdateRequirement {
  const empty: UpdateRequirement = {
    required: false,
    platform: input.platform,
    installedBuild: input.installedBuild,
    minBuild: null,
    storeUrl: '',
  };

  if (!input.isFresh || !input.isNative || input.role !== 'student' || !input.platform) return empty;
  const target = input.policy[input.platform];
  if (!input.policy.enforcementEnabled || !target.enabled) return empty;
  if (input.installedBuild === null || !isValidStoreUrl(input.platform, target.storeUrl)) return empty;

  return {
    required: input.installedBuild < target.minBuild,
    platform: input.platform,
    installedBuild: input.installedBuild,
    minBuild: target.minBuild,
    storeUrl: target.storeUrl,
  };
}

export function validateMobileReleasePolicy(policy: MobileReleasePolicy): string[] {
  const errors: string[] = [];
  (['android', 'ios'] as const).forEach(platform => {
    const target = policy[platform];
    if (!Number.isSafeInteger(target.minBuild) || target.minBuild < 1) {
      errors.push(`${platform}.minBuild`);
    }
    if (!isValidStoreUrl(platform, target.storeUrl)) {
      errors.push(`${platform}.storeUrl`);
    }
  });
  return errors;
}
