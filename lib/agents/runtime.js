/**
 * PersonalDash agent-runtime contract.
 *
 * The runtime is the seam between PersonalDash product code (chat UI, future
 * commands/model picker/profiles) and a concrete agent backend. Today the only
 * implementation is the Hermes adapter (`hermesRuntime.js`); this file exists
 * to keep protocol churn out of the UI layer, not to support hypothetical
 * non-Hermes runtimes.
 *
 * Contract notes:
 * - An AgentRuntime instance is bound to ONE agent target. Hermes profiles /
 *   Bots select and configure a runtime (`createHermesRuntime({ profile })`);
 *   session methods never see profile options, because a profile owns config,
 *   memory, skills, credentials and the session namespace.
 * - Connection state subscriptions are `onConnectionState(handler)` +
 *   `onEvent(handler)` on the runtime, NOT `onState`: `onState` is the
 *   underlying HermesGatewayClient method and only the adapter may call it.
 *   (`hermesRuntime.test.js` guards this surface.)
 * - Live vs stored session ids are part of the contract (Hermes branches the
 *   live session id on compression); implementations surface both honestly.
 * - Events keep the Hermes event vocabulary. The adapter isolates transport,
 *   not event semantics.
 * - Command/model primitives mirror Hermes semantics deliberately: model
 *   switching is `commands.dispatch({ command: '/model X --session' })`,
 *   not an abstract "set model" call, so scope flags stay visible.
 *
 * @typedef {{
 *   id: string,
 *   provider: 'hermes',
 *   profile?: string,
 *   endpoint?: string,
 * }} AgentRuntimeDescriptor
 *
 * @typedef {{
 *   liveSessionId: string,
 *   storedSessionId: string,
 *   title: string,
 *   model?: string,
 * }} AgentSessionBinding
 *
 * @typedef {ReturnType<typeof import('./hermesRuntime.js').createHermesRuntime>} AgentRuntime
 */

/**
 * Thrown when a capability is not implemented by the runtime yet. UI feature
 * flags can catch this to hide the corresponding affordance cleanly.
 */
export class NotSupportedError extends Error {
  constructor(capability) {
    super(`Runtime does not support capability: ${capability}`);
    this.name = 'NotSupportedError';
    this.capability = capability;
  }
}
