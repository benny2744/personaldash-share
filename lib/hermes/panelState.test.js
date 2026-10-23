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

describe('normalizePanelState composer heights', () => {
  it('defaults both composers to auto-grow (null)', () => {
    assert.equal(DEFAULT_PANEL_STATE.composerHeight, null);
    assert.equal(DEFAULT_PANEL_STATE.dingtalkComposerHeight, null);
    assert.equal(normalizePanelState({}).composerHeight, null);
    assert.equal(normalizePanelState(undefined).dingtalkComposerHeight, null);
  });

  it('keeps a stored manual height and clamps it', () => {
    assert.equal(normalizePanelState({ composerHeight: 320 }).composerHeight, 320);
    assert.equal(
      normalizePanelState({ dingtalkComposerHeight: 400 }).dingtalkComposerHeight,
      400,
    );
    assert.equal(normalizePanelState({ composerHeight: 10 }).composerHeight, 84);
    assert.equal(
      normalizePanelState({ composerHeight: 9999 }).composerHeight,
      560,
    );
    assert.equal(normalizePanelState({ composerHeight: 99.6 }).composerHeight, 100);
  });

  it('treats garbage as auto-grow, not the minimum height', () => {
    assert.equal(normalizePanelState({ composerHeight: 'tall' }).composerHeight, null);
    assert.equal(normalizePanelState({ composerHeight: NaN }).composerHeight, null);
    assert.equal(normalizePanelState({ composerHeight: '' }).composerHeight, null);
  });
});
