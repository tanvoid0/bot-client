import React, { useState, useEffect } from 'react';
import { aiFactory } from '../dist/index.js';

interface Message {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: Date;
  provider?: string;
  model?: string;
}

interface ProviderInfo {
  id: string;
  name: string;
  models: string[];
}

const AIReactExample: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [availableProviders, setAvailableProviders] = useState<ProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Initialize and get available providers
    const initializeAI = async () => {
      try {
        // Wait for factory to be ready
        await ensureFactoryReady();
        
        const providerIds = aiFactory.getAvailableProviders();
        const providers: ProviderInfo[] = [];
        
        for (const providerId of providerIds) {
          const provider = aiFactory.getProvider(providerId);
          if (provider) {
            providers.push({
              id: providerId,
              name: provider.providerName,
              models: provider.supportedModels
            });
          }
        }
        
        setAvailableProviders(providers);
        
        // Set default provider and model
        if (providers.length > 0) {
          setSelectedProvider(providers[0].id);
          if (providers[0].models.length > 0) {
            setSelectedModel(providers[0].models[0]);
          }
        }
        
        // Add welcome message
        setMessages([{
          id: '1',
          text: `Hello! I'm your AI assistant. Available providers: ${providers.map(p => p.name).join(', ')}`,
          isUser: false,
          timestamp: new Date()
        }]);
      } catch (err) {
        setError('Failed to initialize AI client');
        console.error('AI initialization error:', err);
      }
    };

    initializeAI();
  }, []);

  const sendMessage = async () => {
    if (!inputText.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: inputText,
      isUser: true,
      timestamp: new Date(),
      provider: selectedProvider,
      model: selectedModel
    };

    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setIsLoading(true);
    setError(null);

    try {
      // Get the specific provider
      const provider = aiFactory.getProvider(selectedProvider);
      if (!provider) {
        throw new Error(`Provider ${selectedProvider} not found`);
      }

      // Use the specific provider to process the request
      const response = await provider.process({
        prompt: inputText,
        modelId: selectedModel,
        maxTokens: 500,
        temperature: 0.7
      });

      const aiMessage: Message = {
        id: (Date.now() + 1).toString(),
        text: response.data || 'No response received',
        isUser: false,
        timestamp: new Date(),
        provider: selectedProvider,
        model: response.modelUsed || selectedModel
      };

      setMessages(prev => [...prev, aiMessage]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get AI response');
      console.error('AI generation error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([]);
    setError(null);
  };

  const handleProviderChange = (providerId: string) => {
    setSelectedProvider(providerId);
    const provider = availableProviders.find(p => p.id === providerId);
    if (provider && provider.models.length > 0) {
      setSelectedModel(provider.models[0]);
    } else {
      setSelectedModel('');
    }
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId);
  };

  const getCurrentProvider = () => {
    return availableProviders.find(p => p.id === selectedProvider);
  };

  return (
    <div style={{ 
      maxWidth: '800px', 
      margin: '0 auto', 
      padding: '20px',
      fontFamily: 'Arial, sans-serif',
      backgroundColor: '#f5f5f5',
      minHeight: '100vh'
    }}>
      <div style={{
        backgroundColor: 'white',
        borderRadius: '10px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          backgroundColor: '#4CAF50',
          color: 'white',
          padding: '20px',
          textAlign: 'center'
        }}>
          <h1 style={{ margin: 0, fontSize: '24px' }}>🤖 AI Client Demo</h1>
          <p style={{ margin: '10px 0 0 0', opacity: 0.9 }}>
            Available Providers: {availableProviders.length > 0 ? availableProviders.map(p => p.name).join(', ') : 'None'}
          </p>
        </div>

        {/* Provider and Model Selection */}
        <div style={{
          padding: '15px 20px',
          backgroundColor: '#f8f9fa',
          borderBottom: '1px solid #e0e0e0',
          display: 'flex',
          gap: '15px',
          alignItems: 'center',
          flexWrap: 'wrap'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={{ fontWeight: 'bold', fontSize: '14px' }}>Provider:</label>
            <select
              value={selectedProvider}
              onChange={(e) => handleProviderChange(e.target.value)}
              style={{
                padding: '6px 10px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                fontSize: '14px',
                minWidth: '120px'
              }}
            >
              {availableProviders.map(provider => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={{ fontWeight: 'bold', fontSize: '14px' }}>Model:</label>
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={!selectedProvider}
              style={{
                padding: '6px 10px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                fontSize: '14px',
                minWidth: '150px',
                opacity: selectedProvider ? 1 : 0.6
              }}
            >
              {getCurrentProvider()?.models.map(model => (
                <option key={model} value={model}>
                  {model}
                </option>
              )) || <option>No models available</option>}
            </select>
          </div>

          <div style={{ 
            fontSize: '12px', 
            color: '#666',
            marginLeft: 'auto'
          }}>
            {selectedProvider && selectedModel && (
              <span>Using: <strong>{getCurrentProvider()?.name}</strong> - <strong>{selectedModel}</strong></span>
            )}
          </div>
        </div>

        {/* Messages */}
        <div style={{
          height: '400px',
          overflowY: 'auto',
          padding: '20px',
          backgroundColor: '#fafafa'
        }}>
          {messages.map((message) => (
            <div
              key={message.id}
              style={{
                marginBottom: '15px',
                display: 'flex',
                justifyContent: message.isUser ? 'flex-end' : 'flex-start'
              }}
            >
              <div style={{
                maxWidth: '70%',
                padding: '12px 16px',
                borderRadius: '18px',
                backgroundColor: message.isUser ? '#4CAF50' : '#e0e0e0',
                color: message.isUser ? 'white' : 'black',
                wordWrap: 'break-word'
              }}>
                <div style={{ marginBottom: '5px' }}>
                  {message.text}
                </div>
                <div style={{
                  fontSize: '11px',
                  opacity: 0.7,
                  textAlign: 'right',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <span>
                    {message.provider && message.model && (
                      <span style={{ 
                        backgroundColor: message.isUser ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)',
                        padding: '2px 6px',
                        borderRadius: '10px',
                        fontSize: '10px',
                        marginRight: '8px'
                      }}>
                        {message.provider} - {message.model}
                      </span>
                    )}
                  </span>
                  <span>{message.timestamp.toLocaleTimeString()}</span>
                </div>
              </div>
            </div>
          ))}
          
          {isLoading && (
            <div style={{
              display: 'flex',
              justifyContent: 'flex-start',
              marginBottom: '15px'
            }}>
              <div style={{
                padding: '12px 16px',
                borderRadius: '18px',
                backgroundColor: '#e0e0e0',
                color: '#666'
              }}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <div style={{
                    width: '20px',
                    height: '20px',
                    border: '2px solid #ccc',
                    borderTop: '2px solid #4CAF50',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                    marginRight: '10px'
                  }}></div>
                  AI is thinking...
                </div>
              </div>
            </div>
          )}

          {error && (
            <div style={{
              padding: '12px 16px',
              backgroundColor: '#ffebee',
              color: '#c62828',
              borderRadius: '8px',
              marginBottom: '15px',
              border: '1px solid #ffcdd2'
            }}>
              <strong>Error:</strong> {error}
            </div>
          )}
        </div>

        {/* Input */}
        <div style={{
          padding: '20px',
          backgroundColor: 'white',
          borderTop: '1px solid #e0e0e0'
        }}>
          <div style={{ display: 'flex', gap: '10px' }}>
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Type your message here..."
              disabled={isLoading}
              style={{
                flex: 1,
                padding: '12px',
                border: '1px solid #ddd',
                borderRadius: '8px',
                resize: 'vertical',
                minHeight: '50px',
                fontFamily: 'inherit',
                fontSize: '14px'
              }}
            />
            <button
              onClick={sendMessage}
              disabled={!inputText.trim() || isLoading}
              style={{
                padding: '12px 24px',
                backgroundColor: isLoading ? '#ccc' : '#4CAF50',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: isLoading ? 'not-allowed' : 'pointer',
                fontSize: '14px',
                fontWeight: 'bold'
              }}
            >
              {isLoading ? 'Sending...' : 'Send'}
            </button>
            <button
              onClick={clearChat}
              style={{
                padding: '12px 16px',
                backgroundColor: '#f44336',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Status Info */}
      <div style={{
        marginTop: '20px',
        padding: '15px',
        backgroundColor: 'white',
        borderRadius: '8px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
      }}>
        <h3 style={{ margin: '0 0 10px 0', color: '#333' }}>📊 Status</h3>
        <div style={{ fontSize: '14px', color: '#666' }}>
          <div><strong>Available Providers:</strong> {availableProviders.length}</div>
          <div><strong>Current Provider:</strong> {getCurrentProvider()?.name || 'None'}</div>
          <div><strong>Current Model:</strong> {selectedModel || 'None'}</div>
          <div><strong>Messages:</strong> {messages.length}</div>
          <div><strong>Status:</strong> {isLoading ? 'Processing...' : 'Ready'}</div>
        </div>
        
        {availableProviders.length > 0 && (
          <div style={{ marginTop: '15px' }}>
            <h4 style={{ margin: '0 0 8px 0', color: '#333', fontSize: '14px' }}>Provider Details:</h4>
            {availableProviders.map(provider => (
              <div key={provider.id} style={{ 
                marginBottom: '8px', 
                padding: '8px', 
                backgroundColor: provider.id === selectedProvider ? '#e8f5e8' : '#f5f5f5',
                borderRadius: '4px',
                border: provider.id === selectedProvider ? '1px solid #4CAF50' : '1px solid #ddd'
              }}>
                <div style={{ fontWeight: 'bold', fontSize: '13px' }}>{provider.name}</div>
                <div style={{ fontSize: '12px', color: '#666' }}>
                  Models: {provider.models.length > 0 ? provider.models.join(', ') : 'None available'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

export default AIReactExample;
