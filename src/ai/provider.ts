/**
 * AI provider interface (see SPEC.md, "AI provider layer").
 * Adapters for Anthropic, Google, and OpenAI implement this in Phase 2.
 * The app must never depend on a vendor's response shape directly.
 */

import type { Caption } from '../types';

export type CompletionRequest = {
  system: string;
  user: string;
  image?: Blob;
  maxTokens: number;
};

export interface AIProvider {
  id: 'anthropic' | 'google' | 'openai';
  complete(req: CompletionRequest): Promise<string>;
  describeImage(image: Blob): Promise<string>;
  transcribe?(audio: Blob): Promise<Caption[]>;
}
