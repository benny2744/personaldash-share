/**
 * Persist chat workspace panel visibility/widths in localStorage.
 */

const STORAGE_KEY = 'personaldash.hermes.chat.panels';

export const DEFAULT_PANEL_STATE = {
  sessionsOpen: true,
  sessionsWidth: 280,
  workspaceOpen: true,
  workspaceWidth: 300,
  workspaceTab: 'files',
  // Diagnostics dock stays closed by default; tool activity is inline.
  activityOpen: false,
  activityHeight: 160,
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
    activityOpen:
      typeof value.activityOpen === 'boolean'
        ? value.activityOpen
        : DEFAULT_PANEL_STATE.activityOpen,
    activityHeight: clamp(
      Number(value.activityHeight) || DEFAULT_PANEL_STATE.activityHeight,
      96,
      360,
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
