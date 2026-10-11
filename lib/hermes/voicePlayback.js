/**
 * Pure helpers + controller for one-at-a-time Hermes reply TTS playback.
 * Primary path: Qwen realtime PCM streaming over a leased WebSocket.
 * Fallback: POST /api/hermes/speak → audio/wav when streaming is unavailable.
 */

import {
  base64ToInt16,
  openVoiceSession,
  prepareStreamSpeechText,
  TTS_SAMPLE_RATE,
} from './voiceStream.js';

/**
 * @param {object | null | undefined} message
 */
export function canSpeakReply(message) {
  if (!message || message.role !== 'assistant') return false;
  if (message.streaming) return false;
  return Boolean(String(message.content || '').trim());
}

/**
 * @param {'idle'|'synthesizing'|'playing'|'error'} state
 * @param {string | null} activeId
 * @param {string} messageId
 */
export function playbackButtonState(state, activeId, messageId) {
  if (activeId !== messageId) return 'idle';
  return state || 'idle';
}

/**
 * Resolve the next UI label for the speaker control.
 * @param {'idle'|'synthesizing'|'playing'|'error'} buttonState
 */
export function playbackButtonLabel(buttonState) {
  switch (buttonState) {
    case 'synthesizing':
      return 'Cancel speech';
    case 'playing':
      return 'Stop playback';
    case 'error':
      return 'Retry speech';
    default:
      return 'Play reply';
  }
}

function createPcmPlayer(options = {}) {
  const AudioContextCtor =
    options.AudioContextCtor ||
    globalThis.AudioContext ||
    globalThis.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('Web Audio API is unavailable');
  }

  const ctx = new AudioContextCtor();
  let nextTime = 0;
  let activeSources = 0;
  let onIdle = null;
  let closed = false;

  async function ensureRunning() {
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  return {
    async playPcm16(int16, sampleRate = TTS_SAMPLE_RATE) {
      if (closed || !int16?.length) return;
      await ensureRunning();
      const floats = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i += 1) {
        floats[i] = int16[i] / 0x8000;
      }
      const buffer = ctx.createBuffer(1, floats.length, sampleRate);
      buffer.copyToChannel(floats, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime + 0.02, nextTime);
      source.start(startAt);
      nextTime = startAt + buffer.duration;
      activeSources += 1;
      source.onended = () => {
        activeSources -= 1;
        if (activeSources <= 0 && onIdle) onIdle();
      };
    },
    stop() {
      try {
        ctx.close();
      } catch {
        // ignore
      }
      closed = true;
      activeSources = 0;
      nextTime = 0;
    },
    onBecameIdle(handler) {
      onIdle = handler;
    },
  };
}

/**
 * Browser-side one-at-a-time reply playback controller.
 * Safe to construct only in client components.
 */
export function createReplyPlaybackController(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const AudioCtor = options.AudioCtor || globalThis.Audio;
  const WebSocketCtor = options.WebSocketCtor || globalThis.WebSocket;
  const AudioContextCtor = options.AudioContextCtor;
  const createObjectURL =
    options.createObjectURL || ((blob) => URL.createObjectURL(blob));
  const revokeObjectURL =
    options.revokeObjectURL || ((url) => URL.revokeObjectURL(url));
  const preferStreaming = options.preferStreaming !== false;

  let state = 'idle';
  let activeId = null;
  let objectUrl = null;
  let audio = null;
  let abortController = null;
  let ws = null;
  let player = null;
  let generation = 0;
  const listeners = new Set();

  function emit() {
    const snapshot = { state, activeId };
    for (const listener of listeners) listener(snapshot);
  }

  function cleanupMedia() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (ws) {
      try {
        if (ws.readyState === WebSocketCtor.OPEN) {
          ws.send(JSON.stringify({ type: 'cancel' }));
        }
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
    if (player) {
      player.stop();
      player = null;
    }
    if (audio) {
      try {
        audio.pause();
      } catch {
        // ignore
      }
      audio.onended = null;
      audio.onerror = null;
      audio = null;
    }
    if (objectUrl) {
      try {
        revokeObjectURL(objectUrl);
      } catch {
        // ignore
      }
      objectUrl = null;
    }
  }

  function stop(nextState = 'idle') {
    generation += 1;
    cleanupMedia();
    state = nextState;
    if (nextState === 'idle') activeId = null;
    emit();
  }

  async function playViaHttp(text, myGen) {
    abortController = new AbortController();
    const response = await fetchImpl('/api/hermes/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text || '') }),
      signal: abortController.signal,
    });
    if (myGen !== generation) return;

    if (!response.ok) {
      let detail = `Speech failed (${response.status})`;
      try {
        const payload = await response.json();
        if (payload?.error) detail = payload.error;
      } catch {
        // ignore
      }
      throw new Error(detail);
    }

    const blob = await response.blob();
    if (myGen !== generation) return;

    objectUrl = createObjectURL(blob);
    audio = new AudioCtor(objectUrl);
    audio.onended = () => {
      if (myGen !== generation) return;
      cleanupMedia();
      state = 'idle';
      activeId = null;
      emit();
    };
    audio.onerror = () => {
      if (myGen !== generation) return;
      cleanupMedia();
      state = 'error';
      emit();
    };

    state = 'playing';
    emit();
    await audio.play();
  }

  async function playViaStream(text, myGen) {
    const prepared = prepareStreamSpeechText(text);
    if (!prepared.ok) {
      const error = new Error(prepared.error);
      error.status = prepared.status;
      throw error;
    }

    let sawAudio = false;
    let streamError = null;
    let providerFinished = false;

    const session = await openVoiceSession('tts', {
      fetchImpl,
      WebSocketCtor,
      location: options.location,
      onMessage: async (msg) => {
        if (myGen !== generation) return;
        if (msg?.type === 'error') {
          streamError = new Error(msg.message || 'Speech stream failed');
          return;
        }
        if (msg?.type === 'audio.delta' && msg.audio) {
          if (!player) {
            player = createPcmPlayer({ AudioContextCtor });
            player.onBecameIdle(() => {
              if (myGen !== generation) return;
              if (providerFinished) {
                cleanupMedia();
                state = 'idle';
                activeId = null;
                emit();
              }
            });
          }
          if (!sawAudio) {
            sawAudio = true;
            state = 'playing';
            emit();
          }
          try {
            await player.playPcm16(
              base64ToInt16(msg.audio),
              msg.sampleRate || TTS_SAMPLE_RATE,
            );
          } catch (error) {
            streamError = error instanceof Error ? error : new Error(String(error));
          }
          return;
        }
        if (msg?.type === 'audio.done' || msg?.type === 'finished') {
          providerFinished = true;
        }
      },
    });

    if (myGen !== generation) {
      try {
        session.ws.close();
      } catch {
        // ignore
      }
      return;
    }

    ws = session.ws;
    ws.send(JSON.stringify({ type: 'text.append', text: prepared.text }));
    ws.send(JSON.stringify({ type: 'finish' }));

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (myGen !== generation) return;
      if (streamError) throw streamError;
      if (providerFinished) {
        // Give the scheduler a moment to start; idle callback clears state.
        if (!sawAudio) {
          throw new Error('Speech stream finished without audio');
        }
        return;
      }
      if (
        ws.readyState === WebSocketCtor.CLOSED ||
        ws.readyState === WebSocketCtor.CLOSING
      ) {
        if (streamError) throw streamError;
        if (!sawAudio) throw new Error('Speech stream closed without audio');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error('Speech stream timed out');
  }

  async function toggle(messageId, text) {
    if (!messageId) return;
    if (
      activeId === messageId &&
      (state === 'playing' || state === 'synthesizing')
    ) {
      stop('idle');
      return;
    }

    cleanupMedia();
    const myGen = ++generation;
    activeId = messageId;
    state = 'synthesizing';
    emit();

    try {
      const canStream =
        preferStreaming &&
        typeof WebSocketCtor === 'function' &&
        Boolean(
          AudioContextCtor ||
            globalThis.AudioContext ||
            globalThis.webkitAudioContext,
        );

      if (canStream) {
        try {
          await playViaStream(text, myGen);
          return;
        } catch (streamError) {
          if (myGen !== generation) return;
          cleanupMedia();
          options.onStreamFallback?.(streamError);
        }
      }

      await playViaHttp(text, myGen);
    } catch (error) {
      if (error?.name === 'AbortError' || myGen !== generation) return;
      cleanupMedia();
      state = 'error';
      emit();
      throw error;
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener({ state, activeId });
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return { state, activeId };
    },
    toggle,
    stop: () => stop('idle'),
    dispose() {
      listeners.clear();
      stop('idle');
    },
  };
}
