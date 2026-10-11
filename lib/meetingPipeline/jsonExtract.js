/**
 * lib/meetingPipeline/jsonExtract.js — Robust JSON extraction from LLM outputs.
 *
 * Uses jsonrepair to fix common LLM JSON mistakes (trailing commas, unescaped
 * newlines, missing quotes) after extracting the largest balanced JSON block.
 */

import { jsonrepair } from 'jsonrepair';

const MAX_SNIPPET_LENGTH = 800;

function snippet(text) {
  return String(text || '').slice(0, MAX_SNIPPET_LENGTH);
}

function stripCodeFence(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function findBalancedBlock(text) {
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  let end = -1;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{' || char === '[') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}' || char === ']') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0) {
          end = i;
        }
      }
    }
  }

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function extractJsonBlock(text) {
  const cleaned = stripCodeFence(text);
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    /* fall through to block extraction */
  }

  const block = findBalancedBlock(cleaned);
  if (block) return block;

  const objectStart = cleaned.indexOf('{');
  const objectEnd = cleaned.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    return cleaned.slice(objectStart, objectEnd + 1);
  }

  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    return cleaned.slice(arrayStart, arrayEnd + 1);
  }

  return cleaned;
}

function parseWithRepair(candidate) {
  try {
    return JSON.parse(candidate);
  } catch {
    const repaired = jsonrepair(candidate);
    return JSON.parse(repaired);
  }
}

/**
 * Extract and parse JSON from an LLM response.
 *
 * @param {string} text
 * @param {Object} [options]
 * @param {boolean} [options.array=false] - Whether an array is the expected top-level shape.
 * @returns {Object|Array}
 */
export function repairAndParseJson(text, { array = false } = {}) {
  const block = extractJsonBlock(text);
  if (!block) {
    throw new Error(
      `LLM did not return a JSON ${array ? 'array' : 'object'}: ${snippet(text)}`,
    );
  }

  let parsed;
  try {
    parsed = parseWithRepair(block);
  } catch (error) {
    throw new Error(
      `Failed to parse LLM JSON: ${error.message} (snippet: ${snippet(block)})`,
    );
  }

  if (array && !Array.isArray(parsed)) {
    throw new Error(`LLM JSON was not an array as expected: ${snippet(block)}`);
  }
  if (
    !array &&
    (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
  ) {
    throw new Error(
      `LLM JSON was not an object as expected: ${snippet(block)}`,
    );
  }

  return parsed;
}
