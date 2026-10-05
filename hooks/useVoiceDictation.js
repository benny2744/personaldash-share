'use client';

/**
 * Consumer-agnostic voice dictation state machine, extracted from the Hermes
 * chat composer. Wraps startStreamingTranscription (mic → PCM → streaming
 * ASR) and exposes a toggle/cancel UI surface plus a "live" flag so hosts can
 * freeze transcript application when the user edits manually mid-take.
 *
 * The hook owns no text state: onPartial receives both the raw transcript and
 * the merge against the base text the take started from (chat-style full-draft
 * replacement), and onReset lets the host revert on cancel.
 */

import { useEffect, useRef, useState } from 'react';
import {
  canStartRecording,
  VOICE_MAX_SECONDS,
} from '@/lib/hermes/voiceRecording';
import { startStreamingTranscription } from '@/lib/hermes/voiceCapture';
import { applyLiveVoiceTranscript } from '@/lib/hermes/transcriptDraft';

export default function useVoiceDictation({
  onPartial,
  onSettled,
  onReset,
  offline = false,
  disabled = false,
  busy = false,
} = {}) {
  const captureRef = useRef(null);
  const liveRef = useRef(false);
  const startingRef = useRef(false);
  const baseRef = useRef('');
  const lastAppliedRef = useRef('');
  const [voiceState, setVoiceState] = useState('idle');
  const [voiceError, setVoiceError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [starting, setStarting] = useState(false);

  const onPartialRef = useRef(onPartial);
  onPartialRef.current = onPartial;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;

  const micEnabled = canStartRecording(voiceState, { offline, disabled, busy });
  const micEnabledRef = useRef(micEnabled);
  micEnabledRef.current = micEnabled;

  useEffect(() => {
    if (voiceState !== 'recording') return undefined;
    setElapsed(0);
    const timer = setInterval(() => {
      setElapsed((current) => current + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [voiceState]);

  function cleanupRecording() {
    liveRef.current = false;
    startingRef.current = false;
    if (captureRef.current) {
      try {
        captureRef.current.cancel();
      } catch {
        // ignore
      }
      captureRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      cleanupRecording();
    };
  }, []);

  /**
   * Stop overwriting the host text — used when the user edits manually
   * mid-take or before sending a chat message. The capture keeps draining
   * until its settle window closes, but nothing more is applied.
   */
  function freeze() {
    liveRef.current = false;
    const capture = captureRef.current;
    if (capture) {
      try {
        capture.suppressDraftUpdates?.();
      } catch {
        // ignore
      }
    }
  }

  function applyPartial(transcript) {
    if (!liveRef.current) return;
    const merged = applyLiveVoiceTranscript(baseRef.current, transcript);
    lastAppliedRef.current = merged;
    onPartialRef.current?.({ transcript, merged });
  }

  async function start(baseText = '') {
    if (!micEnabledRef.current || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    // Tear down any post-stop settle window from a previous take.
    if (captureRef.current) {
      try {
        captureRef.current.cancel();
      } catch {
        // ignore
      }
      captureRef.current = null;
    }
    setVoiceError('');
    baseRef.current = baseText;
    lastAppliedRef.current = baseText;
    liveRef.current = true;
    try {
      const capture = await startStreamingTranscription({
        onPartial: applyPartial,
        onSettled: (info) => {
          liveRef.current = false;
          startingRef.current = false;
          if (captureRef.current === capture) {
            captureRef.current = null;
          }
          // A settle that arrives while still 'recording' (freeze / suppress,
          // server error) must not strand the UI in a dead-recording state.
          setVoiceState((current) => {
            if (current !== 'recording') return current;
            return info?.reason === 'error' ? 'error' : 'idle';
          });
          onSettledRef.current?.(info);
        },
        onAutoStop: () => {
          stop();
        },
        maxSeconds: VOICE_MAX_SECONDS,
      });
      captureRef.current = capture;
      setVoiceState('recording');
      setStarting(false);
    } catch (error) {
      cleanupRecording();
      setVoiceState('error');
      setVoiceError(
        error?.name === 'NotAllowedError'
          ? 'Microphone permission denied'
          : error.message || 'Could not start microphone',
      );
    }
  }

  function stop() {
    const capture = captureRef.current;
    if (!capture) {
      // No live capture (e.g. it already settled) — make sure the UI resets.
      setVoiceState('idle');
      setElapsed(0);
      return;
    }

    // Keep liveRef true so post-commit finals can still land.
    let latest = '';
    try {
      latest = String(capture.stop() || '').trim();
    } catch (error) {
      liveRef.current = false;
      captureRef.current = null;
      setVoiceState('error');
      setVoiceError(error.message || String(error));
      setElapsed(0);
      return;
    }

    const takeProducedText =
      String(lastAppliedRef.current || '').trim() !==
        String(baseRef.current || '').trim() || Boolean(latest);
    if (!takeProducedText) {
      liveRef.current = false;
      captureRef.current = null;
      setVoiceState('error');
      setVoiceError('No speech detected');
      setElapsed(0);
      return;
    }

    // Idle/editable immediately; capture keeps applying until settle/edit.
    setVoiceState('idle');
    setElapsed(0);
  }

  function cancel() {
    cleanupRecording();
    onResetRef.current?.(baseRef.current);
    lastAppliedRef.current = baseRef.current;
    setVoiceState('idle');
    setVoiceError('');
    setElapsed(0);
  }

  return {
    voiceState,
    voiceError,
    elapsed,
    micEnabled,
    starting,
    start,
    stop,
    cancel,
    freeze,
    isLive: () => liveRef.current,
    getLastApplied: () => lastAppliedRef.current,
  };
}
