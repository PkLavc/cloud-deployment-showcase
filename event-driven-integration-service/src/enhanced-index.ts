import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import Stripe from 'stripe';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// Enhanced modules
import { WebhookSecurity } from './security';
import { EnhancedCacheManager } from './services/enhanced-cache-manager';
import { EnhancedCircuitBreakerFactory } from './services/enhanced-circuit-breaker';
import { EnhancedDatabaseManager } from './services/enhanced-database-manager';
import { logger } from './services/logger';

// Environment variables
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PAYPAL_WEBHOOK_SECRET = process.env.PAYPAL_WEBHOOK_SECRET;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'event-driven-integration-service';
const JAEGER_ENDPOINT = process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces';

// Initialize OpenTelemetry
const jaegerExporter = new JaegerExporter({
  endpoint: JAEGER_ENDPOINT,
});

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: OTEL_SERVICE_NAME,
  }),
  traceExporter: jaegerExporter,
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
  ],
});

sdk.start();

// Initialize enhanced services
const prisma = new PrismaClient();
const redis = new Redis(REDIS_URL);

// Enhanced cache manager with LRU and distributed locking
const cacheManager = new EnhancedCacheManager(redis, {
  defaultTTL: 3600,
  maxMemoryUsage: 100 * 1024 * 1024, // 100MB limit
  maxCacheSize: 1000,
  cleanupInterval: 60000, // 1 minute
  enableMetrics: NODE_ENV === 'production',
  lockTimeout: 10000,
  maxRetries: 5
});

// Enhanced database manager with circuit breaker
const databaseManager = new EnhancedDatabaseManager(prisma, {
  connectionTimeout: 5000,
  maxConnections: 10,
  connectionRetryDelay: 1000,
  enableCircuitBreaker: true
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

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

// Enhanced health check endpoint with detailed status
app.get('/health', async (req, res) => {
  try {
    // Test database connection with circuit breaker
    const dbHealthy = await databaseManager.testConnection();
    
    // Test Redis connection
    await redis.ping();
    
    // Get cache health status
    const cacheHealth = cacheManager.getHealthStatus();
    
    // Get database health status
    const dbHealth = databaseManager.getHealthStatus();
    
    // Check memory usage
    const memUsage = process.memoryUsage();
    
    const overallHealthy = dbHealthy && cacheHealth.healthy && dbHealth.healthy;
    
    res.status(overallHealthy ? 200 : 503).json({
      status: overallHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        rss: memUsage.rss,
        heapTotal: memUsage.heapTotal,
        heapUsed: memUsage.heapUsed,
        external: memUsage.external,
      },
      services: {
        database: {
          status: dbHealthy ? 'connected' : 'disconnected',
          ...dbHealth
        },
        redis: 'connected',
        cache: cacheHealth
      },
      issues: [
        ...(!dbHealthy ? ['Database connection failed'] : []),
        ...(!cacheHealth.healthy ? cacheHealth.issues : []),
        ...(!dbHealth.healthy ? dbHealth.issues : [])
      ]
    });
  } catch (error) {
    logger.error('Enhanced health check failed:', error as Error);
    res.status(503).json({
      status: 'unhealthy',
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
      issues: ['Health check failed']
    });
  }
});

// Enhanced Stripe webhook handler with circuit breaker and distributed locking
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'] as string;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error('Stripe webhook signature verification failed:', err as Error);
    return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
  }

  try {
    // Use circuit breaker for database operations
    const webhookEvent = await databaseManager.execute(async () => {
      return await prisma.webhookEvent.create({
        data: {
          eventId: event.id,
          provider: 'stripe',
          eventType: event.type,
          payload: event.data,
          signature: sig,
          status: 'received',
        },
      });
    });

    // Process payment events with distributed locking
    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      
      await databaseManager.execute(async () => {
        return await prisma.paymentEvent.create({
          data: {
            paymentId: paymentIntent.id,
            provider: 'stripe',
            amount: paymentIntent.amount / 100,
            currency: paymentIntent.currency,
            status: 'completed',
            description: paymentIntent.description,
            metadata: paymentIntent.metadata,
            webhookEventId: webhookEvent.id,
          },
        });
      });

      // Cache the payment event with LRU and distributed locking
      await cacheManager.set(
        'payment',
        paymentIntent.id,
        {
          id: paymentIntent.id,
          amount: paymentIntent.amount / 100,
          currency: paymentIntent.currency,
          status: 'completed',
        },
        3600
      );
    }

    await databaseManager.execute(async () => {
      return await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: 'processed', processedAt: new Date() },
      });
    });

    res.json({ received: true });
  } catch (error) {
    logger.error('Enhanced Stripe webhook processing failed:', error as Error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Webhook processing failed due to service unavailability'
    });
  }
});

// Enhanced PayPal webhook handler with circuit breaker
app.post('/webhooks/paypal', async (req, res) => {
  const webhookId = req.headers['paypal-transmission-id'] as string;
  const webhookTimestamp = req.headers['paypal-transmission-time'] as string;
  const webhookSignature = req.headers['paypal-transmission-sig'] as string;
  const certUrl = req.headers['paypal-cert-url'] as string;
  const authAlgo = req.headers['paypal-auth-algo'] as string;

  // Verify PayPal webhook signature
  const isValid = verifyPayPalWebhookSignature(
    req.body,
    webhookSignature,
    PAYPAL_WEBHOOK_SECRET
  );

  if (!isValid) {
    logger.error('PayPal webhook signature verification failed');
    return res.status(400).send('Invalid signature');
  }

  try {
    const payload = req.body;
    const eventType = payload.event_type;

    // Use circuit breaker for database operations
    const webhookEvent = await databaseManager.execute(async () => {
      return await prisma.webhookEvent.create({
        data: {
          eventId: webhookId,
          provider: 'paypal',
          eventType: eventType,
          payload: payload,
          signature: webhookSignature,
          status: 'received',
        },
      });
    });

    // Process payment events with circuit breaker
    if (eventType === 'PAYMENT.SALE.COMPLETED') {
      const sale = payload.resource;
      
      await databaseManager.execute(async () => {
        return await prisma.paymentEvent.create({
          data: {
            paymentId: sale.id,
            provider: 'paypal',
            amount: parseFloat(sale.amount.total),
            currency: sale.amount.currency,
            status: 'completed',
            description: sale.description,
            metadata: { paypal_sale_id: sale.id },
            webhookEventId: webhookEvent.id,
          },
        });
      });

      // Cache the payment event
      await cacheManager.set(
        'payment',
        sale.id,
        {
          id: sale.id,
          amount: parseFloat(sale.amount.total),
          currency: sale.amount.currency,
          status: 'completed',
        },
        3600
      );
    }

    await databaseManager.execute(async () => {
      return await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: 'processed', processedAt: new Date() },
      });
    });

    res.json({ received: true });
  } catch (error) {
    logger.error('Enhanced PayPal webhook processing failed:', error as Error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Webhook processing failed due to service unavailability'
    });
  }
});

// Enhanced GitHub webhook handler with circuit breaker
app.post('/webhooks/github', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'] as string;
  const event = req.headers['x-github-event'] as string;

  // Verify GitHub webhook signature
  const isValid = verifyGitHubWebhookSignature(
    req.body,
    signature,
    GITHUB_WEBHOOK_SECRET
  );

  if (!isValid) {
    logger.error('GitHub webhook signature verification failed');
    return res.status(400).send('Invalid signature');
  }

  try {
    const payload = req.body;

    // Use circuit breaker for database operations
    const webhookEvent = await databaseManager.execute(async () => {
      return await prisma.webhookEvent.create({
        data: {
          eventId: payload.delivery_id || uuidv4(),
          provider: 'github',
          eventType: event,
          payload: payload,
          signature: signature,
          status: 'received',
        },
      });
    });

    // Cache the webhook event
    await cacheManager.set(
      'github',
      webhookEvent.id,
      {
        id: webhookEvent.id,
        event: event,
        repository: payload.repository?.name,
        timestamp: new Date().toISOString(),
      },
      1800
    );

    await databaseManager.execute(async () => {
      return await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: 'processed', processedAt: new Date() },
      });
    });

    res.json({ received: true });
  } catch (error) {
    logger.error('Enhanced GitHub webhook processing failed:', error as Error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Webhook processing failed due to service unavailability'
    });
  }
});

// Enhanced API endpoints with circuit breaker and distributed locking
app.get('/api/payments/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Try cache first with distributed locking
    const cached = await cacheManager.get('payment', id);
    if (cached) {
      logger.cache('payment_found_in_cache', id, true);
      return res.json(cached);
    }

    // Query database with circuit breaker
    const payment = await databaseManager.execute(async () => {
      return await prisma.paymentEvent.findUnique({
        where: { paymentId: id },
      });
    });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Cache the result with LRU
    await cacheManager.set('payment', id, payment, 3600);

    res.json(payment);
  } catch (error) {
    logger.error('Enhanced payment retrieval failed:', error as Error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Payment retrieval failed due to service unavailability'
    });
  }
});

app.get('/api/webhooks/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const webhook = await databaseManager.execute(async () => {
      return await prisma.webhookEvent.findUnique({
        where: { id },
      });
    });

    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    res.json(webhook);
  } catch (error) {
    logger.error('Enhanced webhook retrieval failed:', error as Error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Webhook retrieval failed due to service unavailability'
    });
  }
});

// Enhanced error handling middleware with proper logging
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', error as Error, {
    url: req.url,
    method: req.method,
    ip: req.ip
  });
  
  res.status(500).json({
    error: 'Internal server error',
    message: NODE_ENV === 'production' ? 'Something went wrong' : (error as Error).message,
    timestamp: new Date().toISOString()
  });
});

// Metrics endpoint for monitoring
app.get('/metrics', async (req, res) => {
  try {
    const cacheMetrics = cacheManager.getMetrics();
    const dbHealth = databaseManager.getHealthStatus();
    
    res.json({
      timestamp: new Date().toISOString(),
      cache: cacheMetrics,
      database: dbHealth,
      memory: process.memoryUsage(),
      uptime: process.uptime()
    });
  } catch (error) {
    logger.error('Metrics endpoint failed:', error as Error);
    res.status(500).json({ error: 'Failed to retrieve metrics' });
  }
});

// Start server
const server = app.listen(PORT, () => {
  logger.info(`Enhanced server running on port ${PORT}`, {
    env: NODE_ENV,
    port: PORT,
  });
});

// Enhanced graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(async () => {
    try {
      await databaseManager.disconnect();
      await redis.disconnect();
      await sdk.shutdown();
      process.exit(0);
    } catch (error) {
      logger.error('Graceful shutdown failed:', error as Error);
      process.exit(1);
    }
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(async () => {
    try {
      await databaseManager.disconnect();
      await redis.disconnect();
      await sdk.shutdown();
      process.exit(0);
    } catch (error) {
      logger.error('Graceful shutdown failed:', error as Error);
      process.exit(1);
    }
  });
});

// Helper functions
function verifyPayPalWebhookSignature(payload: any, signature: string, secret: string): boolean {
  // Simplified signature verification for demo
  // In production, use PayPal's official SDK
  return signature === secret;
}

function verifyGitHubWebhookSignature(payload: any, signature: string, secret: string): boolean {
  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex')}`;

  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(signature)
  );
}

export { app, prisma, redis };