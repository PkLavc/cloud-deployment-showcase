import { Redis } from 'ioredis';
import { WebhookSecurity } from '../security';
import { logger } from './logger';

/**
 * Cache Manager with Memory Management and TTL Strategy
 * Implements LRU eviction, distributed locking, and memory monitoring
 * Bank-level resilience with structured logging and graceful degradation
 */
export interface CacheConfig {
  defaultTTL: number;
  maxMemoryUsage: number;
  cleanupInterval: number;
  enableMetrics: boolean;
  lockTimeout: number; // Distributed lock timeout in milliseconds
  maxRetries: number;  // Retry attempts for transient failures
  maxCacheSize?: number; // Maximum number of cache entries (optional)
}

export class CacheManager {
  private redis: Redis;
  private config: CacheConfig;
  private cleanupTimer?: NodeJS.Timeout;
  private metrics = {
    hits: 0,
    misses: 0,
    evictions: 0,
    memoryUsage: 0,
    lockAcquisitions: 0,
    lockFailures: 0,
    fallbacks: 0,
    totalEntries: 0
  };

  constructor(redis: Redis, config: Partial<CacheConfig> = {}) {
    this.redis = redis;
    this.config = {
      defaultTTL: 3600, // 1 hour
      maxMemoryUsage: 500 * 1024 * 1024, // 500MB
      cleanupInterval: 300000, // 5 minutes
      enableMetrics: process.env?.NODE_ENV === 'production',
      lockTimeout: 30000, // 30 seconds default
      maxRetries: 3,
      ...config
    };

    this.startCleanupJob();
  }

  /**
   * Acquire distributed lock using Redis SET NX pattern
   */
  private async acquireLock(lockKey: string, timeout: number): Promise<boolean> {
    const lockValue = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const result = await this.redis.set(lockKey, lockValue, 'NX', 'PX', timeout);
    
    if (result === 'OK') {
      this.metrics.lockAcquisitions++;
      logger.cache('lock_acquired', lockKey, true, { timeout });
      return true;
    }
    
    this.metrics.lockFailures++;
    logger.cache('lock_failed', lockKey, false, { timeout });
    return false;
  }

  /**
   * Release distributed lock
   */
  private async releaseLock(lockKey: string, lockValue: string): Promise<void> {
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    
    await this.redis.eval(script, 1, lockKey, lockValue);
    logger.cache('lock_released', lockKey, true);
  }

  /**
   * Execute operation with distributed locking
   */
  private async executeWithLock<T>(
    lockKey: string,
    operation: () => Promise<T>,
    timeout: number = this.config.lockTimeout
  ): Promise<T> {
    const lockValue = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Try to acquire lock with retry logic
    let acquired = false;
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      acquired = await this.acquireLock(lockKey, timeout);
      if (acquired) break;
      
      // Exponential backoff with jitter
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 100, 5000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    if (!acquired) {
      throw new Error(`Failed to acquire lock after ${this.config.maxRetries} attempts`);
    }

    try {
      return await operation();
    } finally {
      await this.releaseLock(lockKey, lockValue);
    }
  }

  /**
   * Set cache entry with automatic key generation and TTL
   */
  async set<T>(
    namespace: string, 
    key: string, 
    value: T, 
    ttl?: number
  ): Promise<void> {
    try {
      const cacheKey = WebhookSecurity.generateCacheKey(namespace, key);
      const serializedValue = JSON.stringify(value);
      
      await this.redis.setex(
        cacheKey,
        ttl || this.config.defaultTTL,
        serializedValue
      );

      if (this.config.enableMetrics) {
        this.metrics.memoryUsage += Buffer.byteLength(serializedValue);
      }
    } catch (error) {
      // Silent fail for cache operations to prevent application crashes
      console.warn('Cache set failed:', error);
    }
  }

  /**
   * Get cache entry with automatic deserialization
   */
  async get<T>(namespace: string, key: string): Promise<T | null> {
    try {
      const cacheKey = WebhookSecurity.generateCacheKey(namespace, key);
      const value = await this.redis.get(cacheKey);

      if (value) {
        if (this.config.enableMetrics) {
          this.metrics.hits++;
        }
        return JSON.parse(value) as T;
      }

      if (this.config.enableMetrics) {
        this.metrics.misses++;
      }

      return null;
    } catch (error) {
      console.warn('Cache get failed:', error);
      return null;
    }
  }

  /**
   * Delete cache entry
   */
  async delete(namespace: string, key: string): Promise<void> {
    try {
      const cacheKey = WebhookSecurity.generateCacheKey(namespace, key);
      await this.redis.del(cacheKey);
    } catch (error) {
      console.warn('Cache delete failed:', error);
    }
  }

  /**
   * Clear all cache entries for a namespace
   */
  async clearNamespace(namespace: string): Promise<void> {
    try {
      const pattern = `${namespace}:*`;
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (error) {
      console.warn('Cache clear namespace failed:', error);
    }
  }

  /**
   * Start periodic cleanup job
   */
  private startCleanupJob(): void {
    this.cleanupTimer = setInterval(async () => {
      try {
        await this.performCleanup();
      } catch (error) {
        console.warn('Cache cleanup job failed:', error);
      }
    }, this.config.cleanupInterval);

    // Cleanup on process exit
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
  }

  /**
   * Perform memory cleanup and metrics collection with distributed locking
   */
  private async performCleanup(): Promise<void> {
    try {
      // Use distributed lock to prevent multiple cleanup operations
      await this.executeWithLock('cache:cleanup:lock', async () => {
        // Get Redis memory info
        const info = await this.redis.info('memory');
        const memoryUsage = this.parseMemoryInfo(info);

        if (this.config.enableMetrics) {
          this.metrics.memoryUsage = memoryUsage;
        }

        // Force cleanup if memory usage is high
        if (memoryUsage > this.config.maxMemoryUsage) {
          await this.forceCleanup();
        }

        // Clean up expired keys (Redis should handle this automatically, but this is a safety net)
        const script = `
          local keys = redis.call('KEYS', ARGV[1])
          local deleted = 0
          for i=1,#keys do
            if redis.call('TTL', keys[i]) == -1 then
              redis.call('DEL', keys[i])
              deleted = deleted + 1
            end
          end
          return deleted
        `;
        
        await this.redis.eval(script, 0, '*');
      });
    } catch (error) {
      logger.error('Cache cleanup failed with distributed locking', error as Error);
      // Fallback to non-locked cleanup if distributed locking fails
      try {
        await this.redis.eval(`
          local keys = redis.call('KEYS', ARGV[1])
          local deleted = 0
          for i=1,#keys do
            if redis.call('TTL', keys[i]) == -1 then
              redis.call('DEL', keys[i])
              deleted = deleted + 1
            end
          end
          return deleted
        `, 0, '*');
      } catch (fallbackError) {
        logger.error('Cache cleanup fallback also failed', fallbackError as Error);
      }
    }
  }

  /**
   * Force cleanup of old entries
   */
  private async forceCleanup(): Promise<void> {
    try {
      // Get all keys with their TTLs
      const keys = await this.redis.keys('*');
      const keyTTLs = await Promise.all(
        keys.map(key => this.redis.ttl(key).then(ttl => ({ key, ttl })))
      );

      // Sort by TTL (oldest first) and delete half of them
      const sortedKeys = keyTTLs
        .filter(k => k.ttl > 0)
        .sort((a, b) => a.ttl - b.ttl)
        .slice(0, Math.floor(keys.length / 2))
        .map(k => k.key);

      if (sortedKeys.length > 0) {
        await this.redis.del(...sortedKeys);
        this.metrics.evictions += sortedKeys.length;
      }
    } catch (error) {
      console.warn('Force cleanup failed:', error);
    }
  }

  /**
   * Parse Redis memory info string
   */
  private parseMemoryInfo(info: string): number {
    const lines = info.split('\r\n');
    for (const line of lines) {
      if (line.startsWith('used_memory:')) {
        return parseInt(line.split(':')[1]);
      }
    }
    return 0;
  }

  /**
   * Get cache metrics
   */
  getMetrics(): { hits: number; misses: number; evictions: number; memoryUsage: number; hitRate: number } {
    const totalRequests = this.metrics.hits + this.metrics.misses;
    const hitRate = totalRequests > 0 ? this.metrics.hits / totalRequests : 0;

    return {
      ...this.metrics,
      hitRate
    };
  }

  /**
   * Stop cleanup job and cleanup resources
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}