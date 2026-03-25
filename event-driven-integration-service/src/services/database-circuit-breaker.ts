import { CircuitBreaker, CircuitBreakerOptions } from './circuit-breaker';
import { logger } from './logger';

/**
 * Database Circuit Breaker with connection pooling protection
 * Prevents database cascading failures with optimized memory usage
 */
export interface DatabaseCircuitBreakerOptions extends CircuitBreakerOptions {
  connectionTimeout: number;
  maxConnections: number;
  connectionRetryDelay: number;
}

export class DatabaseCircuitBreaker {
  private circuitBreaker: CircuitBreaker<any>;
  private activeConnections = 0;
  private connectionQueue: Array<() => void> = [];

  constructor(
    private readonly connectionAction: () => Promise<any>,
    options: Partial<DatabaseCircuitBreakerOptions> = {}
  ) {
    const circuitOptions: CircuitBreakerOptions = {
      timeout: 5000, // 5 seconds
      errorThresholdPercentage: 30,
      resetTimeout: 10000, // 10 seconds
      volumeThreshold: 10,
      windowSize: 200,
      ...options
    };

    this.circuitBreaker = new CircuitBreaker(this.connectionAction, circuitOptions);
  }

  /**
   * Execute database operation with circuit breaker protection
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      // Check connection limits
      if (this.activeConnections >= 10) {
        logger.warn('Database connection limit reached, queuing request');
        await this.waitForConnection();
      }

      this.activeConnections++;
      
      // Execute with circuit breaker
      const connection = await this.circuitBreaker.execute();
      const result = await operation();
      
      logger.database('query_success', 'database', Date.now());
      return result;
    } catch (error) {
      logger.error('Database operation failed', error as Error, {
        circuitState: this.circuitBreaker.getState(),
        activeConnections: this.activeConnections
      });
      throw error;
    } finally {
      this.activeConnections = Math.max(0, this.activeConnections - 1);
      this.processConnectionQueue();
    }
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
    if (this.connectionQueue.length > 0 && this.activeConnections < 10) {
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
    return {
      ...this.circuitBreaker.getStats(),
      activeConnections: this.activeConnections,
      queuedConnections: this.connectionQueue.length
    };
  }

  /**
   * Check if database is healthy
   */
  isHealthy(): boolean {
    const stats = this.getStats();
    return stats.state === 'CLOSED' && this.activeConnections < 8;
  }
}

/**
 * Database Circuit Breaker Factory
 */
export class DatabaseCircuitBreakerFactory {
  static createPostgreSQLBreaker(connectionAction: () => Promise<any>): DatabaseCircuitBreaker {
    return new DatabaseCircuitBreaker(connectionAction, {
      timeout: 5000,
      errorThresholdPercentage: 30,
      resetTimeout: 10000,
      volumeThreshold: 10,
      windowSize: 200,
      connectionTimeout: 30000,
      maxConnections: 10,
      connectionRetryDelay: 1000
    });
  }
}