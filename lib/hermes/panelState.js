/**
 * Persist chat workspace panel visibility/widths in localStorage.
 */

const STORAGE_KEY = 'personaldash.hermes.chat.panels';

// Composer sizing (Hermes + DingTalk): null = auto-grow with content up to a
// CSS cap; a number = manual height set by dragging the composer grip. The
// clamps live here so normalizePanelState and the grip drag agree.
export const COMPOSER_MIN_HEIGHT = 84;
export const COMPOSER_MAX_HEIGHT = 560;

export const DEFAULT_PANEL_STATE = {
  sessionsOpen: true,
  sessionsWidth: 280,
  workspaceOpen: true,
  workspaceWidth: 300,
  workspaceTab: 'files',
  // Session statistics section pinned to the bottom of the workspace panel.
  statsOpen: true,
  // Diagnostics dock stays closed by default; tool activity is inline.
  activityOpen: false,
  activityHeight: 160,
  // Composers default to auto-grow (null); a drag stores a manual height.
  composerHeight: null,
  dingtalkComposerHeight: null,
  chatMode: 'hermes',
  // Selected Hermes profile ('' = launch default). Runtime selection, not chat state.
  hermesProfile: '',
};

/**
 * @param {unknown} raw
 */
export function normalizePanelState(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    sessionsOpen:
      typeof value.sessionsOpen === 'boolean'
        ? value.sessionsOpen
        : DEFAULT_PANEL_STATE.sessionsOpen,
    sessionsWidth: clamp(
      Number(value.sessionsWidth) || DEFAULT_PANEL_STATE.sessionsWidth,
      200,
      420,
    ),
    workspaceOpen:
      typeof value.workspaceOpen === 'boolean'
        ? value.workspaceOpen
        : DEFAULT_PANEL_STATE.workspaceOpen,
    workspaceWidth: clamp(
      Number(value.workspaceWidth) || DEFAULT_PANEL_STATE.workspaceWidth,
      220,
      520,
    ),
    workspaceTab: ['files', 'artifacts', 'todos'].includes(value.workspaceTab)
      ? value.workspaceTab
      : DEFAULT_PANEL_STATE.workspaceTab,
    statsOpen:
      typeof value.statsOpen === 'boolean'
        ? value.statsOpen
        : DEFAULT_PANEL_STATE.statsOpen,
    activityOpen:
      typeof value.activityOpen === 'boolean'
        ? value.activityOpen
        : DEFAULT_PANEL_STATE.activityOpen,
    activityHeight: clamp(
      Number(value.activityHeight) || DEFAULT_PANEL_STATE.activityHeight,
      96,
      360,
    ),
    composerHeight: normalizeComposerHeight(value.composerHeight),
    dingtalkComposerHeight: normalizeComposerHeight(
      value.dingtalkComposerHeight,
    ),
    chatMode: ['hermes', 'dingtalk'].includes(value.chatMode)
      ? value.chatMode
      : DEFAULT_PANEL_STATE.chatMode,
    hermesProfile:
      typeof value.hermesProfile === 'string'
        ? value.hermesProfile
        : DEFAULT_PANEL_STATE.hermesProfile,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Manual composer height: null (auto-grow) or a clamped pixel number. Any
 * other shape (pre-key localStorage, garbage) falls back to auto.
 * @param {unknown} raw
 * @returns {number|null}
 */
function normalizeComposerHeight(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed)) return null;
  return clamp(parsed, COMPOSER_MIN_HEIGHT, COMPOSER_MAX_HEIGHT);
}

export function loadPanelState() {
  if (typeof window === 'undefined') return { ...DEFAULT_PANEL_STATE };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PANEL_STATE };
    return normalizePanelState(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PANEL_STATE };
  }
}

export function savePanelState(state) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(normalizePanelState(state)),
    );
  } catch {
    // privacy mode / quota — ignore
  }
}

const DRAFT_PREFIX = 'personaldash.hermes.chat.draft:';

export function loadDraft(sessionKey = 'new') {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(`${DRAFT_PREFIX}${sessionKey}`) || '';
  } catch {
    return '';
  }
}

export function saveDraft(sessionKey = 'new', text = '') {
  if (typeof window === 'undefined') return;
  try {
    const key = `${DRAFT_PREFIX}${sessionKey}`;
    if (!text) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, text);
    }
  } catch {
    // ignore
  }
}
