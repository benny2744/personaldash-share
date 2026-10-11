/**
 * scripts/register-alias-hooks.mjs — Registers the alias loader before app
 * code runs. Use with --import when the loader itself must be loaded from an
 * absolute path (e.g. when invoked outside the project root).
 */

import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const loaderPath = path.resolve(__filename, '..', 'resolve-alias-loader.mjs');

register(pathToFileURL(loaderPath).href, import.meta.url);
