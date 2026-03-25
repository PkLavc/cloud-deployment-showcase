#!/usr/bin/env node

/**
 * Event-Driven Integration Service - Simulation Runner
 * This version runs with built-in mocks for testing
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// Mock implementations
class MockPrismaClient {
  constructor() {
    this.tables = {
      webhookEvent: [],
      paymentEvent: [],
      cacheEntry: []
    };
    this.idCounter = 1;
  }

  async $queryRaw(query) {
    console.log(`[MOCK PRISMA] Query: ${query}`);
    // Always return success for health check
    return [{ '1': 1 }];
  }

  async create(model, data) {
    const record = {
      id: `mock_${this.idCounter++}`,
      ...data,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.tables[model].push(record);
    console.log(`[MOCK PRISMA] Created ${model}:`, record.id);
    return record;
  }

  async findUnique(model, where) {
    const key = Object.keys(where)[0];
    const value = where[key];
    return this.tables[model].find(record => record[key] === value);
  }

  async update(model, where, data) {
    const key = Object.keys(where)[0];
    const value = where[key];
    const index = this.tables[model].findIndex(record => record[key] === value);
    if (index !== -1) {
      this.tables[model][index] = { 
        ...this.tables[model][index], 
        ...data, 
        updatedAt: new Date() 
      };
      return this.tables[model][index];
    }
    return null;
  }

  async $disconnect() {
    console.log('[MOCK PRISMA] Disconnected');
  }
}

class MockRedis {
  constructor() {
    this.store = new Map();
    this.expiry = new Map();
    this.timers = new Map(); // Map para armazenar referências dos timers
  }

  async set(key, value, ttl) {
    console.log(`[MOCK REDIS] SET ${key}: ${JSON.stringify(value)}`);
    
    // Limpa timer existente se houver (previne memory leak)
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
    
    this.store.set(key, JSON.stringify(value));
    
    if (ttl) {
      const timerId = setTimeout(() => {
        this.store.delete(key);
        this.expiry.delete(key);
        this.timers.delete(key);
        console.log(`[MOCK REDIS] EXPIRED ${key}`);
      }, ttl * 1000);
      
      this.timers.set(key, timerId);
    }
    
    return 'OK';
  }

  async setex(key, seconds, value) {
    console.log(`[MOCK REDIS] SETEX ${key} (${seconds}s): ${JSON.stringify(value)}`);
    
    // Limpa timer existente se houver (previne memory leak)
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
    
    this.store.set(key, JSON.stringify(value));
    this.expiry.set(key, Date.now() + (seconds * 1000));
    
    // Cria novo timer
    const timerId = setTimeout(() => {
      this.store.delete(key);
      this.expiry.delete(key);
      this.timers.delete(key);
      console.log(`[MOCK REDIS] EXPIRED ${key}`);
    }, seconds * 1000);
    
    this.timers.set(key, timerId);
    
    return 'OK';
  }

  async get(key) {
    const expiry = this.expiry.get(key);
    if (expiry && Date.now() > expiry) {
      // Limpa timer e dados expirados (previne memory leak)
      if (this.timers.has(key)) {
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
      }
      this.store.delete(key);
      this.expiry.delete(key);
      console.log(`[MOCK REDIS] EXPIRED ${key}`);
      return null;
    }
    
    const value = this.store.get(key);
    console.log(`[MOCK REDIS] GET ${key}: ${value}`);
    return value ? JSON.parse(value) : null;
  }

  async ping() {
    console.log('[MOCK REDIS] PING');
    return 'PONG';
  }

  async disconnect() {
    // Limpa todos os timers para evitar memory leak
    for (const [key, timerId] of this.timers) {
      clearTimeout(timerId);
    }
    this.timers.clear();
    this.store.clear();
    this.expiry.clear();
    console.log('[MOCK REDIS] Disconnected and cleaned up timers');
  }
}

class MockStripe {
  constructor() {
    this.webhookSecret = 'whsec_test_secret';
  }

  constructEvent(payload, sig, secret) {
    if (sig !== this.webhookSecret) {
      throw new Error('Invalid signature');
    }
    
    return {
      id: 'evt_test_' + Math.random().toString(36).substr(2, 9),
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_test_' + Math.random().toString(36).substr(2, 9),
          amount: 2000,
          currency: 'usd',
          description: 'Test payment',
          metadata: {}
        }
      }
    };
  }
}

// Environment variables
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret';
const PAYPAL_WEBHOOK_SECRET = process.env.PAYPAL_WEBHOOK_SECRET || 'paypal_test_secret';
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || 'github_test_secret';

// Initialize mocks
const mockDB = new MockPrismaClient();
const mockRedis = new MockRedis();
const mockStripe = new MockStripe();

// Express app setup
const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    await mockDB.$queryRaw();
    
    // Test Redis connection
    await mockRedis.ping();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        database: 'connected',
        redis: 'connected',
        jaeger: 'connected',
      },
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        database: 'disconnected',
        redis: 'disconnected',
        jaeger: 'disconnected',
      },
    });
  }
});

// Stripe webhook handler
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = mockStripe.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err instanceof Error ? err.message : 'Unknown error');
    return res.status(400).send(`Webhook Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  try {
    // Store webhook event
    const webhookEvent = await mockDB.create('webhookEvent', {
      eventId: event.id,
      provider: 'stripe',
      eventType: event.type,
      payload: event.data,
      signature: sig,
      status: 'received',
    });

    // Process payment events
    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      
      await mockDB.create('paymentEvent', {
        paymentId: paymentIntent.id,
        provider: 'stripe',
        amount: paymentIntent.amount / 100, // Convert from cents
        currency: paymentIntent.currency,
        status: 'completed',
        description: paymentIntent.description,
        metadata: paymentIntent.metadata,
        webhookEventId: webhookEvent.id,
      });

      // Cache the payment event (fixed TTL - Redis expects seconds)
      await mockRedis.setex(
        `payment:${paymentIntent.id}`,
        3600, // 1 hour in seconds
        {
          id: paymentIntent.id,
          amount: paymentIntent.amount / 100,
          currency: paymentIntent.currency,
          status: 'completed',
        }
      );
    }

    await mockDB.update('webhookEvent', { id: webhookEvent.id }, { status: 'processed', processedAt: new Date() });

    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook processing failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PayPal webhook handler (simplified)
app.post('/webhooks/paypal', async (req, res) => {
  const webhookId = req.headers['paypal-transmission-id'];
  const webhookSignature = req.headers['paypal-transmission-sig'];

  // Verify PayPal webhook signature (simplified for demo)
  const isValid = verifyPayPalWebhookSignature(
    req.body,
    webhookSignature || '',
    PAYPAL_WEBHOOK_SECRET || ''
  );

  if (!isValid) {
    console.error('PayPal webhook signature verification failed');
    return res.status(400).send('Invalid signature');
  }

  try {
    const payload = req.body;
    const eventType = payload.event_type;

    // Store webhook event
    const webhookEvent = await mockDB.create('webhookEvent', {
      eventId: webhookId,
      provider: 'paypal',
      eventType: eventType,
      payload: payload,
      signature: webhookSignature,
      status: 'received',
    });

    // Process payment events
    if (eventType === 'PAYMENT.SALE.COMPLETED') {
      const sale = payload.resource;
      
      await mockDB.create('paymentEvent', {
        paymentId: sale.id,
        provider: 'paypal',
        amount: parseFloat(sale.amount.total),
        currency: sale.amount.currency,
        status: 'completed',
        description: sale.description,
        metadata: { paypal_sale_id: sale.id },
        webhookEventId: webhookEvent.id,
      });

      // Cache the payment event (fixed TTL)
      await mockRedis.setex(
        `payment:${sale.id}`,
        3600, // 1 hour in seconds
        {
          id: sale.id,
          amount: parseFloat(sale.amount.total),
          currency: sale.amount.currency,
          status: 'completed',
        }
      );
    }

    await mockDB.update('webhookEvent', { id: webhookEvent.id }, { status: 'processed', processedAt: new Date() });

    res.json({ received: true });
  } catch (error) {
    console.error('PayPal webhook processing failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GitHub webhook handler (simplified)
app.post('/webhooks/github', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];

  // Verify GitHub webhook signature
  const isValid = verifyGitHubWebhookSignature(
    req.body,
    signature || '',
    GITHUB_WEBHOOK_SECRET || ''
  );

  if (!isValid) {
    console.error('GitHub webhook signature verification failed');
    return res.status(400).send('Invalid signature');
  }

  try {
    const payload = req.body;

    // Store webhook event
    const webhookEvent = await mockDB.create('webhookEvent', {
      eventId: payload.delivery_id || uuidv4(),
      provider: 'github',
      eventType: event,
      payload: payload,
      signature: signature,
      status: 'received',
    });

    // Cache the webhook event (fixed TTL)
    await mockRedis.setex(
      `github:${webhookEvent.id}`,
      1800, // 30 minutes in seconds
      {
        id: webhookEvent.id,
        event: event,
        repository: payload.repository?.name,
        timestamp: new Date().toISOString(),
      }
    );

    await mockDB.update('webhookEvent', { id: webhookEvent.id }, { status: 'processed', processedAt: new Date() });

    res.json({ received: true });
  } catch (error) {
    console.error('GitHub webhook processing failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoints
app.get('/api/payments/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Check cache first
    const cached = await mockRedis.get(`payment:${id}`);
    if (cached) {
      console.log('Payment found in cache:', { paymentId: id });
      return res.json(cached);
    }

    // Query database
    const payment = await mockDB.findUnique('paymentEvent', { paymentId: id });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Cache the result (fixed TTL)
    await mockRedis.setex(
      `payment:${id}`,
      3600, // 1 hour in seconds
      payment
    );

    res.json(payment);
  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/webhooks/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const webhook = await mockDB.findUnique('webhookEvent', { id });

    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    res.json(webhook);
  } catch (error) {
    console.error('Error fetching webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper functions
function verifyPayPalWebhookSignature(payload, signature, secret) {
  // Simplified signature verification for demo
  return signature === secret;
}

function verifyGitHubWebhookSignature(payload, signature, secret) {
  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex')}`;

  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(signature)
  );
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: NODE_ENV === 'production' ? 'Something went wrong' : error.message,
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`, {
    env: NODE_ENV,
    port: PORT,
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(async () => {
    await mockDB.$disconnect();
    await mockRedis.disconnect();
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(async () => {
    await mockDB.$disconnect();
    await mockRedis.disconnect();
    process.exit(0);
  });
});

module.exports = { app, mockDB, mockRedis };