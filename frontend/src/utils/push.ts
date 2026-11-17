import type { PushSubscriptionPayload } from '../types/api';

export function getDetectedTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const classicIos = /iPad|iPhone|iPod/.test(ua);
  const ipadOs =
    ua.includes('Macintosh') &&
    typeof document !== 'undefined' &&
    'ontouchend' in document;
  return classicIos || ipadOs;
}

export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  const mediaStandalone =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;
  const safariStandalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
    true;
  return mediaStandalone || safariStandalone;
}

export function isIosSafariNeedsHomeScreen(): boolean {
  return isIosDevice() && !isStandalonePwa();
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function waitForActiveRegistration(
  timeoutMs = 6000
): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing && existing.active) {
    return existing;
  }

  let timer: number | undefined;
  try {
    const readyPromise = navigator.serviceWorker.ready;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => {
        reject(
          new Error(
            'Service worker is not active yet. Build/preview the PWA or reload and try again.'
          )
        );
      }, timeoutMs);
    });
    return await Promise.race([readyPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
}

export async function getCurrentBrowserPushEndpoint(): Promise<string | null> {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    const sub = await reg.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

export async function subscribeBrowserPush(
  vapidPublicKey: string
): Promise<PushSubscriptionPayload> {
  if (isIosSafariNeedsHomeScreen()) {
    throw new Error(
      'On iOS, tap Share -> Add to Home Screen first, then open MacroLens from your Home Screen to enable push reminders.'
    );
  }

  if (!isPushSupported()) {
    throw new Error('Web Push notifications are not supported in this browser.');
  }

  if (!vapidPublicKey) {
    throw new Error('Server push notifications are not configured yet (missing VAPID key).');
  }

  let permission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    throw new Error(
      'Notification permission was blocked. Allow notifications in browser/OS settings to enable reminders.'
    );
  }

  const registration = await waitForActiveRegistration();
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }

  const json = subscription.toJSON();
  const endpoint = json.endpoint || subscription.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;

  if (!endpoint || !p256dh || !auth) {
    throw new Error('Browser returned an incomplete push subscription.');
  }

  return {
    endpoint,
    keys: { p256dh, auth },
    timezone: getDetectedTimezone(),
    user_agent: navigator.userAgent.slice(0, 240),
  };
}

export async function unsubscribeBrowserPush(): Promise<string | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return undefined;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return undefined;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    return endpoint;
  } catch {
    return undefined;
  }
}
