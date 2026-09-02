import { describe, expect, it } from 'vitest';
import { CHAT_MODEL_LABELS, CODEX_CHAT_MODELS } from './types';

describe('Codex model picker catalog', () => {
  it('shows the GPT-5.6 family and GPT-5.5 with product labels', () => {
    expect(CODEX_CHAT_MODELS).toEqual([
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect(CODEX_CHAT_MODELS.map((model) => CHAT_MODEL_LABELS[model])).toEqual([
      'GPT-5.5',
      'GPT-5.6 Sol',
      'GPT-5.6 Terra',
      'GPT-5.6 Luna',
    ]);
  });
});
