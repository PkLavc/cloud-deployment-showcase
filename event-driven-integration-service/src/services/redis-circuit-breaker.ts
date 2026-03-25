import Redis from 'ioredis';

interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeout: number;
  monitoringPeriod: number;
}

interface CircuitState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
}

export class RedisCircuitBreaker {
  private redis: Redis;
  private options: CircuitBreakerOptions;
  private state: CircuitState;
  private monitoringTimer: NodeJS.Timeout | null = null;

  constructor(redis: Redis, options: CircuitBreakerOptions) {
    this.redis = redis;
    this.options = {
      failureThreshold: options.failureThreshold || 5,
      resetTimeout: options.resetTimeout || 30000, // 30 seconds
      monitoringPeriod: options.monitoringPeriod || 60000, // 1 minute
    };
    
    this.state = {
      state: 'CLOSED',
      failures: 0,
      lastFailureTime: 0,
      lastSuccessTime: 0,
      totalRequests: 0,
      totalFailures: 0,
      totalSuccesses: 0,
    };

    this.startMonitoring();
  }

  private startMonitoring(): void {
    this.monitoringTimer = setInterval(() => {
      this.logStatistics();
    }, this.options.monitoringPeriod);
  }

  private logStatistics(): void {
    const successRate = this.state.totalRequests > 0 
      ? (this.state.totalSuccesses / this.state.totalRequests) * 100 
      : 0;

    console.log(`[REDIS CIRCUIT BREAKER] State: ${this.state.state}, Success Rate: ${successRate.toFixed(2)}%, Failures: ${this.state.failures}/${this.options.failureThreshold}`);
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.state.totalRequests++;

    // If circuit is OPEN, reject immediately
    if (this.state.state === 'OPEN') {
      if (Date.now() - this.state.lastFailureTime > this.options.resetTimeout) {
        console.log('[REDIS CIRCUIT BREAKER] Transitioning to HALF_OPEN');
        this.state.state = 'HALF_OPEN';
        this.state.failures = 0;
      } else {
        throw new Error('Circuit breaker is OPEN - Redis connection temporarily disabled');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.state.totalSuccesses++;
    this.state.lastSuccessTime = Date.now();
    this.state.failures = 0;

    if (this.state.state === 'HALF_OPEN') {
      console.log('[REDIS CIRCUIT BREAKER] Transitioning to CLOSED');
      this.state.state = 'CLOSED';
    }
  }

  private onFailure(): void {
    this.state.totalFailures++;
    this.state.failures++;
    this.state.lastFailureTime = Date.now();

    if (this.state.failures >= this.options.failureThreshold) {
      console.log('[REDIS CIRCUIT BREAKER] Transitioning to OPEN');
      this.state.state = 'OPEN';
    }
  }

  getStats(): CircuitState {
    return { ...this.state };
  }

  async disconnect(): Promise<void> {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
    }
    await this.redis.disconnect();
  }
}