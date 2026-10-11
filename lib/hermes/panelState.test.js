import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PANEL_STATE,
  normalizePanelState,
} from './panelState.js';

describe('normalizePanelState hermesProfile', () => {
  it('defaults to the empty (launch) profile', () => {
    assert.equal(DEFAULT_PANEL_STATE.hermesProfile, '');
    assert.equal(normalizePanelState({}).hermesProfile, '');
    assert.equal(normalizePanelState(undefined).hermesProfile, '');
  });

  it('keeps a stored profile string', () => {
    assert.equal(
      normalizePanelState({ hermesProfile: 'coding' }).hermesProfile,
      'coding',
    );
  });

  it('drops a non-string profile value', () => {
    assert.equal(
      normalizePanelState({ hermesProfile: 42 }).hermesProfile,
      '',
    );
  });

  it('preserves existing panel fields alongside the profile', () => {
    const next = normalizePanelState({
      sessionsOpen: false,
      chatMode: 'dingtalk',
      hermesProfile: 'builder',
    });
    assert.equal(next.sessionsOpen, false);
    assert.equal(next.chatMode, 'dingtalk');
    assert.equal(next.hermesProfile, 'builder');
  });
});
