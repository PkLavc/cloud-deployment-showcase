/**
 * Circuit Breaker Pattern Implementation with Sliding Window
 * Prevents cascading failures in external service calls with O(1) memory usage
 */
export interface CircuitBreakerOptions {
  timeout: number;
  errorThresholdPercentage: number;
  resetTimeout: number;
  volumeThreshold: number;
  windowSize: number; // Maximum number of calls to keep in sliding window
}

export interface CallRecord {
  success: boolean;
  timestamp: number;
}

export class CircuitBreaker<T> {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failures = 0;
  private lastFailureTime = 0;
  private successes = 0;
  private readonly calls: CallRecord[] = [];
  private callIndex = 0; // For circular buffer implementation
  private isFull = false; // Track if circular buffer is full

  constructor(
    private readonly action: () => Promise<T>,
    private readonly options: CircuitBreakerOptions
  ) {}

  async execute(): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.options.resetTimeout) {
        this.state = 'HALF_OPEN';
        this.successes = 0;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await Promise.race([
        this.action(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Circuit breaker timeout')), this.options.timeout)
        )
      ]);

      this.onSuccess();
      return result as T;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.successes++;
    
    if (this.state === 'HALF_OPEN' && this.successes >= 3) {
      this.state = 'CLOSED';
    }

    this.recordCall(true);
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    this.successes = 0;

    this.recordCall(false);

    const recentCalls = this.getRecentCalls();
    const failureRate = recentCalls.filter(call => !call.success).length / recentCalls.length;

    if (recentCalls.length >= this.options.volumeThreshold && 
        failureRate >= this.options.errorThresholdPercentage / 100) {
      this.state = 'OPEN';
    }
  }

  /**
   * Record call using circular buffer for O(1) memory usage
   */
  private recordCall(success: boolean): void {
    const record: CallRecord = { success, timestamp: Date.now() };
    
    if (this.isFull) {
      // Overwrite oldest entry in circular buffer
      this.calls[this.callIndex] = record;
      this.callIndex = (this.callIndex + 1) % this.options.windowSize;
    } else {
      // Add new entry until buffer is full
      this.calls.push(record);
      if (this.calls.length === this.options.windowSize) {
        this.isFull = true;
      }
    }
  }

  /**
   * Get recent calls within the reset timeout window
   */
  private getRecentCalls(): CallRecord[] {
    const cutoff = Date.now() - this.options.resetTimeout;
    const recentCalls: CallRecord[] = [];
    
    // Iterate through circular buffer efficiently
    const bufferSize = this.isFull ? this.options.windowSize : this.calls.length;
    const startIndex = this.isFull ? this.callIndex : 0;
    
    for (let i = 0; i < bufferSize; i++) {
      const index = (startIndex + i) % bufferSize;
      const call = this.calls[index];
      if (call && call.timestamp > cutoff) {
        recentCalls.push(call);
      }
    }
    
    return recentCalls;
  }

  getState(): string {
    return this.state;
  }

  getStats(): { failures: number; successes: number; state: string; windowSize: number; bufferSize: number } {
    return {
      failures: this.failures,
      successes: this.successes,
      state: this.state,
      windowSize: this.options.windowSize,
      bufferSize: this.calls.length
    };
  }
}

/**
 * Circuit breaker factory for common external services with optimized memory usage
 */
export class CircuitBreakerFactory {
  static createStripeBreaker(action: () => Promise<any>): CircuitBreaker<any> {
    return new CircuitBreaker(action, {
      timeout: 10000, // 10 seconds
      errorThresholdPercentage: 50,
      resetTimeout: 30000, // 30 seconds
      volumeThreshold: 5,
      windowSize: 100 // Limit to 100 calls in sliding window
    });
  }

  static createPayPalBreaker(action: () => Promise<any>): CircuitBreaker<any> {
    return new CircuitBreaker(action, {
      timeout: 15000, // 15 seconds
      errorThresholdPercentage: 60,
      resetTimeout: 60000, // 1 minute
      volumeThreshold: 3,
      windowSize: 50 // Limit to 50 calls in sliding window
    });
  }

  static createDatabaseBreaker(action: () => Promise<any>): CircuitBreaker<any> {
    return new CircuitBreaker(action, {
      timeout: 5000, // 5 seconds
      errorThresholdPercentage: 30,
      resetTimeout: 10000, // 10 seconds
      volumeThreshold: 10,
      windowSize: 200 // Limit to 200 calls in sliding window
    });
  }
}
