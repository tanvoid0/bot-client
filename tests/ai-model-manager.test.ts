import { AIModelManager } from '../src/ai-model-manager';
import { AIModelError } from '../src/types';

describe('AIModelManager', () => {
  let manager: AIModelManager;

  beforeEach(() => {
    manager = new AIModelManager();
  });

  describe('Provider Management', () => {
    it('should add a provider successfully', () => {
      manager.addProvider({
        type: 'openai',
        config: {
          name: 'test-gpt',
          apiKey: 'test-key',
          provider: 'openai'
        }
      });

      expect(manager.hasProvider('test-gpt')).toBe(true);
      expect(manager.getProviderCount()).toBe(1);
      expect(manager.getDefaultProvider()).toBe('test-gpt');
    });

    it('should not allow duplicate provider names', () => {
      manager.addProvider({
        type: 'openai',
        config: {
          name: 'test-gpt',
          apiKey: 'test-key',
          provider: 'openai'
        }
      });

      expect(() => {
        manager.addProvider({
          type: 'openai',
          config: {
            name: 'test-gpt',
            apiKey: 'test-key-2',
            provider: 'openai'
          }
        });
      }).toThrow('Provider with name \'test-gpt\' already exists');
    });

    it('should remove a provider successfully', () => {
      manager.addProvider({
        type: 'openai',
        config: {
          name: 'test-gpt',
          apiKey: 'test-key',
          provider: 'openai'
        }
      });

      const removed = manager.removeProvider('test-gpt');
      expect(removed).toBe(true);
      expect(manager.hasProvider('test-gpt')).toBe(false);
      expect(manager.getProviderCount()).toBe(0);
      expect(manager.getDefaultProvider()).toBeNull();
    });

    it('should set default provider', () => {
      manager.addProvider({
        type: 'openai',
        config: {
          name: 'gpt-1',
          apiKey: 'test-key-1',
          provider: 'openai'
        }
      });

      manager.addProvider({
        type: 'openai',
        config: {
          name: 'gpt-2',
          apiKey: 'test-key-2',
          provider: 'openai'
        }
      });

      manager.setDefaultProvider('gpt-2');
      expect(manager.getDefaultProvider()).toBe('gpt-2');
    });

    it('should throw error when setting non-existent provider as default', () => {
      expect(() => {
        manager.setDefaultProvider('non-existent');
      }).toThrow('Provider \'non-existent\' not found');
    });

    it('should get all provider names', () => {
      manager.addProvider({
        type: 'openai',
        config: {
          name: 'gpt-1',
          apiKey: 'test-key-1',
          provider: 'openai'
        }
      });

      manager.addProvider({
        type: 'openai',
        config: {
          name: 'gpt-2',
          apiKey: 'test-key-2',
          provider: 'openai'
        }
      });

      const names = manager.getProviderNames();
      expect(names).toContain('gpt-1');
      expect(names).toContain('gpt-2');
      expect(names).toHaveLength(2);
    });
  });

  describe('Error Handling', () => {
    it('should throw error when no default provider is set', async () => {
      await expect(manager.chat('Hello')).rejects.toThrow('No default provider set');
    });

    it('should throw error when provider not found', async () => {
      await expect(manager.chatCompletionWithProvider('non-existent', 'Hello')).rejects.toThrow('Provider \'non-existent\' not found');
    });
  });

  describe('Constructor with Configs', () => {
    it('should initialize with providers', () => {
      const managerWithConfigs = new AIModelManager([
        {
          type: 'openai',
          config: {
            name: 'gpt-1',
            apiKey: 'test-key-1',
            provider: 'openai'
          }
        },
        {
          type: 'openai',
          config: {
            name: 'gpt-2',
            apiKey: 'test-key-2',
            provider: 'openai'
          }
        }
      ]);

      expect(managerWithConfigs.getProviderCount()).toBe(2);
      expect(managerWithConfigs.getDefaultProvider()).toBe('gpt-1');
    });
  });

  describe('Provider Switching', () => {
    beforeEach(() => {
      manager.addProvider({
        type: 'openai',
        config: {
          name: 'gpt-1',
          apiKey: 'test-key-1',
          provider: 'openai'
        }
      });

      manager.addProvider({
        type: 'openai',
        config: {
          name: 'gpt-2',
          apiKey: 'test-key-2',
          provider: 'openai'
        }
      });
    });

    it('should switch default provider correctly', () => {
      expect(manager.getDefaultProvider()).toBe('gpt-1');
      
      manager.setDefaultProvider('gpt-2');
      expect(manager.getDefaultProvider()).toBe('gpt-2');
    });

    it('should update default provider when first provider is removed', () => {
      expect(manager.getDefaultProvider()).toBe('gpt-1');
      
      manager.removeProvider('gpt-1');
      expect(manager.getDefaultProvider()).toBe('gpt-2');
    });

    it('should set default to null when all providers are removed', () => {
      manager.removeProvider('gpt-1');
      manager.removeProvider('gpt-2');
      
      expect(manager.getDefaultProvider()).toBeNull();
    });
  });
});
