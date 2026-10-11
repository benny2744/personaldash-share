import webPush from 'web-push';

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

if (vapidPublicKey && vapidPrivateKey) {
  webPush.setVapidDetails(
    'mailto:admin@personaldash.local',
    vapidPublicKey,
    vapidPrivateKey,
  );
}

export function isPushConfigured() {
  return Boolean(vapidPublicKey && vapidPrivateKey);
}

export async function sendPushNotification(subscription, payload) {
  if (!isPushConfigured()) {
    console.warn('Push notifications not configured — missing VAPID keys');
    return;
  }
  return webPush.sendNotification(subscription, JSON.stringify(payload));
}

export { webPush };
