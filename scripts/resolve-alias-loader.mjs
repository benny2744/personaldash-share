/**
 * scripts/resolve-alias-loader.mjs — Node import loader so standalone scripts
 * can resolve `@/` aliases used by the application code.
 *
 * Usage:
 *   node --import ./scripts/resolve-alias-loader.mjs scripts/some-script.mjs
 *
 * Expects the workspace root to be the current working directory.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(__filename, '..', '..');

let aliasMap = new Map();

async function loadAliases() {
  if (aliasMap.size) return;
  const jsconfigPath = path.join(ROOT, 'jsconfig.json');
  try {
    const raw = await fs.readFile(jsconfigPath, 'utf8');
    const config = JSON.parse(raw);
    const baseUrl = config.compilerOptions?.baseUrl || '.';
    const basePath = path.resolve(ROOT, baseUrl);
    const paths = config.compilerOptions?.paths || {};
    for (const [alias, targets] of Object.entries(paths)) {
      const cleanAlias = alias.replace(/\/\*$/, '');
      for (const target of targets) {
        const cleanTarget = target.replace(/\/\*$/, '');
        aliasMap.set(cleanAlias, path.resolve(basePath, cleanTarget));
      }
    }
  } catch {
    aliasMap.set('@', ROOT);
  }
}

function resolveAlias(specifier) {
  const keys = [...aliasMap.keys()].sort((a, b) => b.length - a.length);
  for (const alias of keys) {
    const targetDir = aliasMap.get(alias);
    if (specifier === alias || specifier.startsWith(`${alias}/`)) {
      const rest = specifier.slice(alias.length).replace(/^\//, '');
      return path.join(targetDir, rest);
    }
  }
  return null;
}

function isRelativeWithoutExt(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

export async function resolve(specifier, context, nextResolve) {
  await loadAliases();
  const resolvedPath = resolveAlias(specifier);
  if (resolvedPath) {
    const parentUrl = context.parentURL || `file://${process.cwd()}/`;
    const tryResolve = async (candidate) => {
      try {
        return await nextResolve(pathToFileURL(candidate).href, {
          ...context,
          parentURL: parentUrl,
        });
      } catch {
        return null;
      }
    };

    try {
      const stat = await fs.stat(resolvedPath);
      if (stat.isDirectory()) {
        const asIndex = await tryResolve(path.join(resolvedPath, 'index.js'));
        if (asIndex) return asIndex;
        const asIndexMjs = await tryResolve(
          path.join(resolvedPath, 'index.mjs'),
        );
        if (asIndexMjs) return asIndexMjs;
      }
    } catch {
      /* fall through to extension probing */
    }

    for (const ext of ['', '.js', '.mjs']) {
      const candidate = `${resolvedPath}${ext}`;
      const resolved = await tryResolve(candidate);
      if (resolved) return resolved;
    }

    return nextResolve(pathToFileURL(resolvedPath).href, {
      ...context,
      parentURL: parentUrl,
    });
  }

  if (isRelativeWithoutExt(specifier)) {
    const parentPath = fileURLToPath(
      context.parentURL || `file://${process.cwd()}/`,
    );
    const candidate = path.resolve(path.dirname(parentPath), specifier);
    for (const ext of ['.js', '.mjs', '']) {
      const full = `${candidate}${ext}`;
      try {
        await fs.access(full);
        return nextResolve(pathToFileURL(full).href, context);
      } catch {
        /* continue */
      }
    }
  }

  return nextResolve(specifier, context);
}
