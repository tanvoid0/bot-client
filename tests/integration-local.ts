/**
 * Integration tests for local providers (Ollama, LM Studio).
 * No API keys required. Tests are skipped when no local provider is reachable.
 */

import axios from 'axios';
import { AIFactory, OllamaProvider, LMStudioProvider } from '../src/index.js';

const CHECK_TIMEOUT = 2000;
// Long timeout when a real request runs; skip is immediate when provider unavailable
const INTEGRATION_TEST_TIMEOUT = 25000;

async function isOllamaAvailable(): Promise<boolean> {
  try {
    await axios.get('http://localhost:11434/api/tags', { timeout: CHECK_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

async function isLMStudioAvailable(): Promise<boolean> {
  try {
    await axios.get('http://localhost:1234/v1/models', { timeout: CHECK_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

describe('Integration (local providers, no API keys)', () => {
  let ollamaAvailable = false;
  let lmStudioAvailable = false;

  beforeAll(async () => {
    [ollamaAvailable, lmStudioAvailable] = await Promise.all([
      isOllamaAvailable(),
      isLMStudioAvailable()
    ]);
  });

  describe('Ollama', () => {
    test(
      'generates text when Ollama is running',
      async () => {
        if (!ollamaAvailable) return;
        const factory = new AIFactory({
          providers: [new OllamaProvider()],
          defaultProvider: 'ollama'
        });
        await factory.ready();
        const text = await factory.generate('Say "ok" in one word.', { maxTokens: 10 });
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(0);
      },
      INTEGRATION_TEST_TIMEOUT
    );

    test(
      'process returns success and data when Ollama is running',
      async () => {
        if (!ollamaAvailable) return;
        const factory = new AIFactory({ providers: [new OllamaProvider()] });
        await factory.ready();
        const response = await factory.process({
          prompt: 'Reply with the number 1.',
          maxTokens: 5
        });
        expect(response.success).toBe(true);
        expect(response.data).toBeDefined();
        expect(response.providerId).toBe('ollama');
      },
      INTEGRATION_TEST_TIMEOUT
    );
  });

  describe('LM Studio', () => {
    test(
      'generates text when LM Studio is running',
      async () => {
        if (!lmStudioAvailable) return;
        const factory = new AIFactory({
          providers: [new LMStudioProvider()],
          defaultProvider: 'lmstudio'
        });
        await factory.ready();
        const text = await factory.generate('Say "ok" in one word.', { maxTokens: 10 });
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(0);
      },
      INTEGRATION_TEST_TIMEOUT
    );
  });
});
