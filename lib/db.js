/**
 * lib/db.js — Prisma client singleton for Next.js (avoids connection pool exhaustion in dev).
 */

import { createRequire } from 'module';
import config from './config.js';

const require = createRequire(import.meta.url);
const globalForPrisma = globalThis;

// Prevent Prisma from being instantiated in edge runtime or build time evaluation
const isNode = typeof process !== 'undefined' && process.env.NEXT_RUNTIME === 'nodejs';

/** @type {any} */
const prisma = new Proxy({}, {
  get(target, prop) {
    if (!isNode) return undefined;

    if (!globalForPrisma.__prisma) {
      const { Pool } = require('pg');
      const { PrismaPg } = require('@prisma/adapter-pg');
      const { PrismaClient } = require('@prisma/client');
      
      const pool = new Pool({ connectionString: config.databaseUrl });
      const adapter = new PrismaPg(pool);

      globalForPrisma.__prisma = new PrismaClient({ adapter, log: ['error'] });
      globalForPrisma.__prismaPool = pool;
      process.once('beforeExit', () => {
        globalForPrisma.__prismaPool?.end().catch(() => {});
      });
    }
    const client = globalForPrisma.__prisma;
    const value = client[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  }
});

export default prisma;
