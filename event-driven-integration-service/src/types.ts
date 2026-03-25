import { z } from 'zod';

// Schema validation for cached payment data
export const PaymentCacheSchema = z.object({
  id: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: z.string(),
  timestamp: z.string().optional(),
});

export type PaymentCacheData = z.infer<typeof PaymentCacheSchema>;

// Schema validation for webhook payloads
export const WebhookPayloadSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.any(),
  created: z.number().optional(),
});

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

// Health check response types
export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  uptime: number;
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  services: {
    database: boolean;
    redis: boolean;
  };
  errors?: string[];
}

// Circuit breaker configuration
export interface CircuitBreakerConfig {
  timeout: number;
  errorThresholdPercentage: number;
  resetTimeout: number;
  volumeThreshold: number;
}

// Memory monitoring configuration
export interface MemoryConfig {
  threshold: number;
  checkInterval: number;
  gcEnabled: boolean;
}