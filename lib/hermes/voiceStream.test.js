import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  downsampleToRate,
  floatTo16BitPCM,
  pcmToBase64,
  voiceWsUrl,
} from './voiceStream.js';

describe('voiceStream helpers', () => {
  it('downsamples and encodes pcm', () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1, 0, 0.25, -0.25]);
    const down = downsampleToRate(input, 32000, 16000);
    assert.equal(down.length, 4);
    const pcm = floatTo16BitPCM(down);
    assert.equal(pcm.length, 4);
    assert.equal(typeof pcmToBase64(pcm), 'string');
  });

  it('builds same-origin ws urls', () => {
    assert.equal(
      voiceWsUrl('/api/hermes/voice/ws?token=abc', {
        location: { protocol: 'https:', host: 'dash.example' },
      }),
      'wss://dash.example/api/hermes/voice/ws?token=abc',
    );
  });
});
