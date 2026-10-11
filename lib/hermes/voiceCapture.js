/**
 * Push-to-record microphone capture that streams PCM16 @ 16 kHz while recording.
 */

import {
  ASR_SAMPLE_RATE,
  downsampleToRate,
  floatTo16BitPCM,
  openVoiceSession,
  pcmToBase64,
} from './voiceStream.js';
import { VOICE_MAX_SECONDS } from './voiceRecording.js';

/**
 * How long to keep accepting draft updates after Stop while waiting for final.
 * DashScope finalize latency is bimodal: usually <1.5s, but benchmarked up to
 * 7-30s tails (scripts/voice-bench/results.md, 2026-10-06). The 3s window we
 * used before discarded the last sentences of ~17% of takes. Settling on final
 * arrival is unaffected — this is only the cap.
 */
export const ASR_SETTLE_TIMEOUT_MS = 10_000;

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   WebSocketCtor?: typeof WebSocket,
 *   AudioContextCtor?: typeof AudioContext,
 *   getUserMedia?: typeof navigator.mediaDevices.getUserMedia,
 *   onPartial?: (text: string) => void,
 *   onSettled?: (info: { reason: string, text: string }) => void,
 *   onAutoStop?: () => void,
 *   maxSeconds?: number,
 *   settleTimeoutMs?: number,
 *   location?: Location,
 * }} [options]
 */
export async function startStreamingTranscription(options = {}) {
  const WebSocketCtor = options.WebSocketCtor || globalThis.WebSocket;
  const AudioContextCtor =
    options.AudioContextCtor ||
    globalThis.AudioContext ||
    globalThis.webkitAudioContext;
  const getUserMedia =
    options.getUserMedia ||
    navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  const maxSeconds = options.maxSeconds || VOICE_MAX_SECONDS;
  const settleTimeoutMs =
    Number.isFinite(options.settleTimeoutMs) && options.settleTimeoutMs >= 0
      ? options.settleTimeoutMs
      : ASR_SETTLE_TIMEOUT_MS;

  if (!getUserMedia) throw new Error('Microphone API is unavailable');
  if (!AudioContextCtor) throw new Error('Web Audio API is unavailable');
  if (!WebSocketCtor) throw new Error('WebSocket is unavailable');

  const stream = await getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  let finalText = '';
  let partialText = '';
  let error = null;
  let micStopped = false;
  let draftUpdatesEnabled = true;
  let settled = false;
  let closed = false;
  let settleTimer = null;

  function latestText() {
    return finalText || partialText || '';
  }

  function settle(reason) {
    if (settled) return;
    settled = true;
    draftUpdatesEnabled = false;
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    // The session is over no matter what settled it (error / cancel / suppress
    // / timeout). Only stop()/cancel() stop the mic beforehand — freeze or a
    // server-side error can settle mid-recording, and a live mic with a dead
    // socket leaks audio and the user's stop button. Always tear down capture.
    if (!micStopped) {
      micStopped = true;
      cleanupCapture();
    }
    options.onSettled?.({ reason, text: latestText() });
    closeSocketSoon();
  }

  let session;
  try {
    session = await openVoiceSession('asr', {
      fetchImpl: options.fetchImpl,
      WebSocketCtor,
      location: options.location,
      onMessage: (msg) => {
        if (msg?.type === 'error') {
          error = new Error(msg.message || 'Transcription failed');
          if (draftUpdatesEnabled) {
            settle('error');
          }
          return;
        }
        if (!draftUpdatesEnabled) return;

        if (msg?.type === 'transcript.partial' && msg.text) {
          partialText = String(msg.text);
          options.onPartial?.(partialText);
          return;
        }

        if (msg?.type === 'transcript.final') {
          const text = String(msg.text || '').trim();
          if (text) {
            finalText = text;
            partialText = finalText;
            options.onPartial?.(finalText);
          }
          // Final (even empty) ends the settle window after Stop/commit.
          if (micStopped) {
            settle('final');
          }
          return;
        }

        if (msg?.type === 'finished' && micStopped) {
          settle('finished');
        }
      },
    });
  } catch (err) {
    // The mic is already open (getUserMedia resolved) — release it or the
    // browser keeps the indicator on with no capture handle to stop it.
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore
      }
    }
    throw err;
  }

  const audioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but universally available for mic capture.
  const bufferSize = 4096;
  const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
  const mute = audioContext.createGain();
  mute.gain.value = 0;

  processor.onaudioprocess = (event) => {
    if (micStopped || session.ws.readyState !== WebSocketCtor.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    const down = downsampleToRate(
      input,
      audioContext.sampleRate,
      ASR_SAMPLE_RATE,
    );
    const pcm = floatTo16BitPCM(down);
    session.ws.send(
      JSON.stringify({
        type: 'audio.append',
        audio: pcmToBase64(pcm),
      }),
    );
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioContext.destination);

  let autoStopTimer = null;
  if (maxSeconds > 0) {
    autoStopTimer = setTimeout(() => {
      options.onAutoStop?.();
    }, maxSeconds * 1000);
  }

  function cleanupCapture() {
    if (autoStopTimer) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }
    try {
      processor.disconnect();
    } catch {
      // ignore
    }
    try {
      source.disconnect();
    } catch {
      // ignore
    }
    try {
      mute.disconnect();
    } catch {
      // ignore
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore
      }
    }
    try {
      audioContext.close();
    } catch {
      // ignore
    }
  }

  function closeSocketSoon() {
    if (closed) return;
    closed = true;
    try {
      session.ws.close();
    } catch {
      // ignore
    }
  }

  /**
   * Halt mic immediately and return the latest hypothesis.
   * Keeps accepting draft updates until final / timeout / suppress.
   */
  function stop() {
    if (micStopped) return latestText();
    micStopped = true;
    cleanupCapture();
    const latest = latestText();

    if (session.ws.readyState === WebSocketCtor.OPEN) {
      try {
        session.ws.send(JSON.stringify({ type: 'commit' }));
        session.ws.send(JSON.stringify({ type: 'finish' }));
      } catch {
        // ignore
      }
    }

    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settle('timeout');
    }, settleTimeoutMs);

    if (error) throw error;
    return latest;
  }

  function suppressDraftUpdates() {
    settle('suppressed');
  }

  function cancel() {
    micStopped = true;
    draftUpdatesEnabled = false;
    cleanupCapture();
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    try {
      if (session.ws.readyState === WebSocketCtor.OPEN) {
        session.ws.send(JSON.stringify({ type: 'cancel' }));
      }
    } catch {
      // ignore
    }
    settle('cancel');
  }

  return {
    stop,
    cancel,
    suppressDraftUpdates,
    get partialText() {
      return partialText;
    },
    get micStopped() {
      return micStopped;
    },
    get draftUpdatesEnabled() {
      return draftUpdatesEnabled;
    },
    get settled() {
      return settled;
    },
    /** @deprecated Use micStopped; kept for older tests/callers. */
    get stopped() {
      return micStopped;
    },
  };
}
