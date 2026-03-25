import { PrismaClient } from '@prisma/client';
import { EnhancedCircuitBreaker, EnhancedCircuitBreakerFactory } from './enhanced-circuit-breaker';
import { logger } from './logger';

/**
 * Enhanced Database Manager with Circuit Breaker Protection
 * Prevents database cascading failures with proper error handling
 */
export interface EnhancedDatabaseConfig {
  connectionTimeout: number;
  maxConnections: number;
  connectionRetryDelay: number;
  enableCircuitBreaker: boolean;
}

export class EnhancedDatabaseManager {
  private prisma: PrismaClient;
  private circuitBreaker?: EnhancedCircuitBreaker<any>;
  private config: EnhancedDatabaseConfig;
  private activeConnections = 0;
  private connectionQueue: Array<() => void> = [];
  private isHealthy = true;

  constructor(prisma: PrismaClient, config: Partial<EnhancedDatabaseConfig> = {}) {
    this.prisma = prisma;
    this.config = {
      connectionTimeout: 5000,
      maxConnections: 10,
      connectionRetryDelay: 1000,
      enableCircuitBreaker: true,
      ...config
    };

    if (this.config.enableCircuitBreaker) {
      this.circuitBreaker = EnhancedCircuitBreakerFactory.createDatabaseBreaker(
        () => this.prisma.$connect()
      );
    }
  }

  /**
   * Execute database operation with circuit breaker protection
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      // Check connection limits
      if (this.activeConnections >= this.config.maxConnections) {
        logger.warn('Database connection limit reached, queuing request');
        await this.waitForConnection();
      }

      this.activeConnections++;

      // Execute with circuit breaker if enabled
      if (this.circuitBreaker) {
        return await this.circuitBreaker.execute(operation);
      } else {
        return await operation();
      }
    } catch (error) {
      this.isHealthy = false;
      logger.error('Database operation failed', error as Error, {
        circuitState: this.circuitBreaker?.getState(),
        activeConnections: this.activeConnections
      });
      throw error;
    } finally {
      this.activeConnections = Math.max(0, this.activeConnections - 1);
      this.processConnectionQueue();
    }
  }

  /**
   * Execute raw query with circuit breaker protection
   */
  async queryRaw<T = any>(query: string, params?: any[]): Promise<T[]> {
    return this.execute(async () => {
      return await this.prisma.$queryRawUnsafe(query, ...(params || []));
    });
  }

  /**
   * Execute transaction with circuit breaker protection
   */
  async transaction<T>(
    fn: (prisma: PrismaClient) => Promise<T>,
    options?: { timeout?: number; isolationLevel?: any }
  ): Promise<T> {
    return this.execute(async () => {
      return await this.prisma.$transaction(fn, options);
    });
  }

  /**
   * Wait for available connection
   */
  private async waitForConnection(): Promise<void> {
    return new Promise((resolve) => {
      this.connectionQueue.push(resolve);
      
      // Timeout after 30 seconds
      setTimeout(() => {
        const index = this.connectionQueue.indexOf(resolve);
        if (index > -1) {
          this.connectionQueue.splice(index, 1);
        }
        resolve();
      }, 30000);
    });
  }

  /**
   * Process queued connection requests
   */
  private processConnectionQueue(): void {
    if (this.connectionQueue.length > 0 && this.activeConnections < this.config.maxConnections) {
      const next = this.connectionQueue.shift();
      if (next) {
        next();
      }
    }
  }

  /**
   * Get circuit breaker statistics
   */
  getStats() {
    const baseStats = {
      activeConnections: this.activeConnections,
      queuedConnections: this.connectionQueue.length,
      isHealthy: this.isHealthy
    };

    if (this.circuitBreaker) {
      return {
        ...baseStats,
        ...this.circuitBreaker.getStats()
      };
    }

    return baseStats;
  }

  /**
   * Get health status
   */
  getHealthStatus() {
    const stats = this.getStats();
    const issues: string[] = [];

    if (!this.isHealthy) {
      issues.push('Database is unhealthy');
    }

    if (this.activeConnections >= this.config.maxConnections) {
      issues.push('Connection limit reached');
    }

    if (this.circuitBreaker) {
      const cbHealth = this.circuitBreaker.getHealthStatus();
      if (!cbHealth.healthy) {
        issues.push(...cbHealth.issues);
      }
    }

    return {
      healthy: issues.length === 0,
      issues,
      stats
    };
  }

  /**
   * Test database connection
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.execute(async () => {
        await this.prisma.$queryRawUnsafe('SELECT 1');
      });
      this.isHealthy = true;
      return true;
    } catch (error) {
      this.isHealthy = false;
      logger.error('Database connection test failed', error as Error);
      return false;
    }
  }

  /**
   * Disconnect from database
   */
  async disconnect(): Promise<void> {
    try {
      await this.prisma.$disconnect();
      logger.info('Database disconnected successfully');
    } catch (error) {
      logger.error('Database disconnect failed', error as Error);
      throw error;
    }
  }
}