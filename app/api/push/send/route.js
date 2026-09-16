import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { sendPushNotification, isPushConfigured } from '@/lib/push';

export async function POST(request) {
  if (!isPushConfigured()) {
    return NextResponse.json({ error: 'Push notifications not configured' }, { status: 503 });
  }

  try {
    const { title, body, url } = await request.json();

    const subscriptions = await prisma.pushSubscription.findMany();

    const results = await Promise.allSettled(
      subscriptions.map((sub) =>
        sendPushNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          { title, body, url },
        ),
      ),
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.warn(`Failed to send ${failed.length}/${subscriptions.length} push notifications`);
    }

    return NextResponse.json({
      sent: subscriptions.length - failed.length,
      total: subscriptions.length,
    });
  } catch (error) {
    console.error('Error sending push notifications:', error);
    return NextResponse.json({ error: 'Failed to send notifications' }, { status: 500 });
  }
}
