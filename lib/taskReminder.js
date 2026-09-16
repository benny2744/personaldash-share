/**
 * lib/taskReminder.js — Periodic worker that checks for tasks with upcoming due dates
 * and sends push notifications to all subscribed clients.
 */

import prisma from './db.js';
import { sendPushNotification, isPushConfigured } from './push.js';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let intervalId = null;

async function checkAndNotify() {
  if (!isPushConfigured()) return;

  try {
    const now = new Date();
    const in15Min = new Date(now.getTime() + 15 * 60 * 1000);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    // Find tasks due within the next 15 minutes or at end of day that haven't been notified
    const upcomingTasks = await prisma.task.findMany({
      where: {
        status: { notIn: ['Done', 'done', 'Archived', 'archived'] },
        whenDate: {
          gte: now,
          lte: endOfDay,
        },
        note: { deletedAt: null },
      },
      include: { note: { select: { filepath: true } } },
    });

    if (upcomingTasks.length === 0) return;

    const subscriptions = await prisma.pushSubscription.findMany();
    if (subscriptions.length === 0) return;

    const tasksDueSoon = upcomingTasks.filter((task) => {
      if (!task.whenDate) return false;
      const due = new Date(task.whenDate);
      return due <= in15Min;
    });

    const tasksDueToday = upcomingTasks.filter((task) => {
      if (!task.whenDate) return false;
      const due = new Date(task.whenDate);
      return due > in15Min && due <= endOfDay;
    });

    const notifications = [];

    if (tasksDueSoon.length > 0) {
      notifications.push({
        title: 'Task Due Soon',
        body: `${tasksDueSoon.length} task(s) due in the next 15 minutes`,
        url: '/tasks',
      });
    }

    if (tasksDueToday.length > 0 && now.getHours() >= 8 && now.getHours() <= 10) {
      notifications.push({
        title: 'Tasks Due Today',
        body: `You have ${tasksDueToday.length} task(s) due today`,
        url: '/tasks',
      });
    }

    for (const payload of notifications) {
      for (const sub of subscriptions) {
        try {
          await sendPushNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            payload,
          );
        } catch (err) {
          console.error('[reminder] Push failed for', sub.endpoint.slice(0, 50), err.message);
          // Remove invalid subscriptions
          if (err.statusCode === 410) {
            await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
          }
        }
      }
    }

    if (notifications.length > 0) {
      console.log(`[reminder] Sent ${notifications.length} notification(s) to ${subscriptions.length} subscriber(s)`);
    }
  } catch (err) {
    console.error('[reminder] Error checking tasks:', err.message);
  }
}

export function startTaskReminder() {
  if (intervalId) return;
  console.log('[reminder] Starting task reminder worker');
  // Run once on startup after a short delay
  setTimeout(checkAndNotify, 30_000);
  intervalId = setInterval(checkAndNotify, CHECK_INTERVAL_MS);
}

export function stopTaskReminder() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[reminder] Stopped task reminder worker');
  }
}
