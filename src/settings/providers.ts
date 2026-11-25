/**
 * The AI providers Settings offers, in the order shown. There is no default provider: nothing is
 * chosen until the person chooses one (SPEC.md, "AI").
 *
 * Only Claude (Anthropic) is offered so far; Gemini and OpenAI come in Phase 2 task 6.
 */

import type { AIProvider } from '../ai/provider';

export type ProviderId = AIProvider['id'];

export type ProviderInfo = {
  id: ProviderId;
  /** The name shown in Settings. */
  name: string;
  /** The only address the key is ever sent to. */
  host: string;
};

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: 'anthropic', name: 'Claude (Anthropic)', host: 'api.anthropic.com' },
];

/** The provider with this id, or undefined when Settings does not offer it. */
export function findProvider(id: unknown): ProviderInfo | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}
