import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import Stripe from 'stripe';
import { createLogger, format, transports } from 'winston';

// Mock implementations for missing infrastructure
export class MockPrismaClient {
  private tables = {
    webhookEvent: [],
    paymentEvent: [],
    cacheEntry: []
  };
  private idCounter = 1;

  async $queryRaw(query: any) {
    console.log(`[MOCK PRISMA] Query: ${query}`);
    if (query.includes('SELECT 1')) {
      return [{ '1': 1 }];
    }
    return [];
  }

  async webhookEvent() {
    return {
      create: async (data: any) => {
        const record = {
          id: `mock_${this.idCounter++}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        this.tables.webhookEvent.push(record);
        console.log(`[MOCK PRISMA] Created webhookEvent:`, record.id);
        return record;
      },
      findUnique: async (where: any) => {
        const key = Object.keys(where)[0];
        const value = where[key];
        return this.tables.webhookEvent.find(record => record[key] === value);
      },
      update: async (where: any, data: any) => {
        const key = Object.keys(where)[0];
        const value = where[key];
        const index = this.tables.webhookEvent.findIndex(record => record[key] === value);
        if (index !== -1) {
          this.tables.webhookEvent[index] = { 
            ...this.tables.webhookEvent[index], 
            ...data, 
            updatedAt: new Date() 
          };
          return this.tables.webhookEvent[index];
        }
        return null;
      }
    };
  }

  async paymentEvent() {
    return {
      create: async (data: any) => {
        const record = {
          id: `mock_${this.idCounter++}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        this.tables.paymentEvent.push(record);
        console.log(`[MOCK PRISMA] Created paymentEvent:`, record.id);
        return record;
      },
      findUnique: async (where: any) => {
        const key = Object.keys(where)[0];
        const value = where[key];
        return this.tables.paymentEvent.find(record => record[key] === value);
      }
    };
  }

  async $disconnect() {
    console.log('[MOCK PRISMA] Disconnected');
  }
}

export class MockRedis {
  private store = new Map();
  private expiry = new Map();

  async set(key: string, value: any, ttl?: number) {
    console.log(`[MOCK REDIS] SET ${key}: ${JSON.stringify(value)}`);
    this.store.set(key, JSON.stringify(value));
    
    if (ttl) {
      setTimeout(() => {
        this.store.delete(key);
        this.expiry.delete(key);
        console.log(`[MOCK REDIS] EXPIRED ${key}`);
      }, ttl * 1000);
    }
    
    return 'OK';
  }

  async setex(key: string, seconds: number, value: any) {
    console.log(`[MOCK REDIS] SETEX ${key} (${seconds}s): ${JSON.stringify(value)}`);
    this.store.set(key, JSON.stringify(value));
    this.expiry.set(key, Date.now() + (seconds * 1000));
    return 'OK';
  }

  async get(key: string) {
    const expiry = this.expiry.get(key);
    if (expiry && Date.now() > expiry) {
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
    console.log('[MOCK REDIS] Disconnected');
  }
}

export class MockStripe {
  private webhookSecret = 'whsec_test_secret';

  constructEvent(payload: any, sig: string, secret: string) {
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

export const mockLogger = createLogger({
  level: 'debug',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.simple(),
    }),
  ],
});

export const mockPrisma = new MockPrismaClient();
export const mockRedis = new MockRedis();
export const mockStripe = new MockStripe();