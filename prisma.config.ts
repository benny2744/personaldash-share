/**
 * prisma.config.ts — Prisma 7 configuration file.
 * Replaces the deprecated `url` field in schema.prisma datasource block.
 */

import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
  migrations: {
    path: 'prisma/migrations',
  },
});
