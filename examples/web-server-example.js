import express from 'express';
import { aiFactory } from '../dist/index.js';

const app = express();
const port = 3000;

// Middleware
app.use(express.json());
app.use(express.static('examples'));

// Routes
app.get('/', (req, res) => {
  res.sendFile('react-demo.html', { root: 'examples' });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, options = {} } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    console.log(`🤖 Processing message: "${message}"`);
    
    const response = await aiFactory.generate(message, {
      maxTokens: options.maxTokens || 500,
      temperature: options.temperature || 0.7,
      ...options
    });

    console.log(`✅ Response generated: "${response.substring(0, 100)}..."`);

    res.json({
      success: true,
      response: response,
      timestamp: new Date().toISOString(),
      providers: aiFactory.getAvailableProviders()
    });

  } catch (error) {
    console.error('❌ Error processing message:', error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process message',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, options = {} } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    console.log(`🤖 Processing prompt: "${prompt}"`);
    console.log(`📊 Available providers: ${aiFactory.getAvailableProviders().join(', ')}`);
    
    // Check if any providers are available
    const availableProviders = aiFactory.getAvailableProviders();
    if (availableProviders.length === 0) {
      return res.status(503).json({
        success: false,
        error: 'No AI providers are currently available. Please check your configuration and ensure at least one provider is properly set up.',
        timestamp: new Date().toISOString()
      });
    }
    
    let response;
    
    // If specific provider is requested, use it
    if (options.provider) {
      const provider = aiFactory.getProvider(options.provider);
      if (!provider) {
        return res.status(400).json({ error: `Provider ${options.provider} not found` });
      }
      
      console.log(`Using provider: ${provider.providerName} with model: ${options.modelId || 'default'}`);
      
      const aiResponse = await provider.process({
        prompt,
        modelId: options.modelId,
        maxTokens: options.maxTokens || 500,
        temperature: options.temperature || 0.7
      });
      
      console.log(`Provider response:`, { success: aiResponse.success, dataLength: aiResponse.data?.length || 0, error: aiResponse.error });
      
      if (!aiResponse.success) {
        throw new Error(aiResponse.error || 'Provider processing failed');
      }
      
      response = aiResponse.data || '';
    } else {
      // Use default factory method
      response = await aiFactory.generate(prompt, {
        modelId: options.modelId,
        maxTokens: options.maxTokens || 500,
        temperature: options.temperature || 0.7
      });
    }

    console.log(`✅ Response generated: "${response.substring(0, 100)}..."`);

    res.json({
      success: true,
      data: response,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error processing prompt:', error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process prompt',
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const providerIds = aiFactory.getAvailableProviders();
    const providers = [];
    
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
    
    res.json({
      status: 'running',
      providers: providers,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting status:', error);
    res.status(500).json({
      status: 'error',
      providers: [],
      message: 'Failed to get provider status'
    });
  }
});

app.get('/api/providers', async (req, res) => {
  try {
    const providerIds = aiFactory.getAvailableProviders();
    const providers = [];
    
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
    
    res.json({
      providers: providers,
      count: providers.length
    });
  } catch (error) {
    console.error('Error getting providers:', error);
    res.status(500).json({
      providers: [],
      count: 0,
      error: 'Failed to get providers'
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(port, () => {
  console.log(`🚀 AI Client Web Server running at http://localhost:${port}`);
  console.log(`📊 Available providers: ${aiFactory.getAvailableProviders().join(', ')}`);
  console.log(`🌐 Open http://localhost:${port} to see the demo`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down server...');
  process.exit(0);
});
