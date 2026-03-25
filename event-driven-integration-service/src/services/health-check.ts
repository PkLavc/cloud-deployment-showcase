import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { HealthCheckResponse } from '../types';

export class HealthCheckService {
  private prisma: PrismaClient;
  private redis: Redis;
  private memoryThreshold: number;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(prisma: PrismaClient, redis: Redis, memoryThreshold: number = 100 * 1024 * 1024) {
    this.prisma = prisma;
    this.redis = redis;
    this.memoryThreshold = memoryThreshold;
  }

  /**
   * Perform deep health check with active connectivity tests
   */
  async performDeepHealthCheck(): Promise<HealthCheckResponse> {
    const startTime = Date.now();
    const errors: string[] = [];
    const services = {
      database: false,
      redis: false,
    };

    // Test database connectivity
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      services.database = true;
    } catch (error) {
      errors.push(`Database health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Test Redis connectivity
    try {
      await this.redis.ping();
      services.redis = true;
    } catch (error) {
      errors.push(`Redis health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Check memory usage
    const memoryUsage = process.memoryUsage();
    const isMemoryHealthy = memoryUsage.heapUsed < this.memoryThreshold;

    if (!isMemoryHealthy) {
      errors.push(`High memory usage detected: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`);
    }

    const isHealthy = services.database && services.redis && isMemoryHealthy;

    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
      },
      services,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Start memory monitoring with garbage collection
   */
  startMemoryMonitoring(intervalMs: number = 30000): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(() => {
      const usage = process.memoryUsage();
      
      if (usage.heapUsed > this.memoryThreshold) {
        console.warn('High memory usage detected:', {
          heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
          threshold: Math.round(this.memoryThreshold / 1024 / 1024),
          timestamp: new Date().toISOString(),
        });

        // Trigger garbage collection if available
        if (global.gc) {
          global.gc();
        }
      }
    }, intervalMs);
  }

  /**
   * Stop memory monitoring
   */
  stopMemoryMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}