import { Redis } from 'ioredis';
import { WebhookSecurity } from '../security';
import { logger } from './logger';

/**
 * Enhanced Cache Manager with LRU Eviction and Memory Management
 * Fixes race conditions, memory leaks, and silent failures
 */
export interface EnhancedCacheConfig {
  defaultTTL: number;
  maxMemoryUsage: number;
  maxCacheSize: number;
  cleanupInterval: number;
  enableMetrics: boolean;
  lockTimeout: number;
  maxRetries: number;
}

export class EnhancedCacheManager {
  private redis: Redis;
  private config: EnhancedCacheConfig;
  private cleanupTimer?: NodeJS.Timeout;
  private metrics = {
    hits: 0,
    misses: 0,
    evictions: 0,
    memoryUsage: 0,
    lockAcquisitions: 0,
    lockFailures: 0,
    fallbacks: 0,
    totalEntries: 0,
    errors: 0
  };

  constructor(redis: Redis, config: Partial<EnhancedCacheConfig> = {}) {
    this.redis = redis;
    this.config = {
      defaultTTL: 3600, // 1 hour
      maxMemoryUsage: 100 * 1024 * 1024, // 100MB limit
      maxCacheSize: 1000, // Maximum 1000 entries
      cleanupInterval: 60000, // 1 minute cleanup
      enableMetrics: process.env?.NODE_ENV === 'production',
      lockTimeout: 10000, // 10 seconds
      maxRetries: 5,
      ...config
    };

    this.startCleanupJob();
  }

  /**
   * Acquire distributed lock with enhanced error handling
   */
  private async acquireLock(lockKey: string, timeout: number): Promise<string | null> {
    const lockValue = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      const result = await this.redis.set(lockKey, lockValue, 'NX', 'PX', timeout);
      
      if (result === 'OK') {
        this.metrics.lockAcquisitions++;
        logger.cache('lock_acquired', lockKey, true, { timeout });
        return lockValue;
      }
      
      this.metrics.lockFailures++;
      logger.cache('lock_failed', lockKey, false, { timeout });
      return null;
    } catch (error) {
      this.metrics.errors++;
      logger.error('Lock acquisition failed', error as Error, { lockKey });
      return null;
    }
  }

  /**
   * Release distributed lock with enhanced error handling
   */
  private async releaseLock(lockKey: string, lockValue: string): Promise<void> {
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    
    try {
      await this.redis.eval(script, 1, lockKey, lockValue);
      logger.cache('lock_released', lockKey, true);
    } catch (error) {
      this.metrics.errors++;
      logger.error('Lock release failed', error as Error, { lockKey });
    }
  }

  /**
   * Execute operation with distributed locking and proper error handling
   */
  private async executeWithLock<T>(
    lockKey: string,
    operation: () => Promise<T>,
    timeout: number = this.config.lockTimeout
  ): Promise<T> {
    let lockValue: string | null = null;
    
    // Try to acquire lock with retry logic
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      lockValue = await this.acquireLock(lockKey, timeout);
      if (lockValue) break;
      
      // Exponential backoff with jitter
      const delay = Math.min(500 * Math.pow(2, attempt) + Math.random() * 100, 2000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    if (!lockValue) {
      throw new Error(`Failed to acquire lock after ${this.config.maxRetries} attempts`);
    }

    try {
      return await operation();
    } finally {
      if (lockValue) {
        await this.releaseLock(lockKey, lockValue);
      }
    }
  }

  /**
   * Set cache entry with LRU eviction and memory management
   */
  async set<T>(
    namespace: string, 
    key: string, 
    value: T, 
    ttl?: number
  ): Promise<void> {
    const cacheKey = WebhookSecurity.generateCacheKey(namespace, key);
    const serializedValue = JSON.stringify(value);
    const valueSize = Buffer.byteLength(serializedValue);
    
    try {
      // Check memory limits before setting
      if (this.config.enableMetrics && this.metrics.memoryUsage + valueSize > this.config.maxMemoryUsage) {
        logger.warn('Memory limit exceeded, triggering cleanup', { 
          currentUsage: this.metrics.memoryUsage,
          newValueSize: valueSize,
          limit: this.config.maxMemoryUsage 
        });
        await this.enforceMemoryLimits();
      }

      // Use distributed lock for cache operations to prevent race conditions
      await this.executeWithLock(`cache:lock:${cacheKey}`, async () => {
        // Set the value with TTL
        await this.redis.setex(cacheKey, ttl || this.config.defaultTTL, serializedValue);
        
        // Update metrics
        if (this.config.enableMetrics) {
          this.metrics.memoryUsage += valueSize;
          this.metrics.totalEntries++;
        }

        // Update LRU tracking
        await this.updateLRU(cacheKey);
      });

      logger.cache('cache_set', cacheKey, true, { 
        size: valueSize,
        ttl: ttl || this.config.defaultTTL 
      });

    } catch (error) {
      this.metrics.errors++;
      logger.error('Cache set failed', error as Error, { cacheKey });
      throw error; // Don't silently fail - let caller handle
    }
  }

  /**
   * Get cache entry with LRU update and proper error handling
   */
  async get<T>(namespace: string, key: string): Promise<T | null> {
    const cacheKey = WebhookSecurity.generateCacheKey(namespace, key);
    
    try {
      // Use distributed lock for cache get to prevent race conditions
      return await this.executeWithLock(`cache:lock:${cacheKey}`, async () => {
        const value = await this.redis.get(cacheKey);

        if (value) {
          if (this.config.enableMetrics) {
            this.metrics.hits++;
          }
          
          // Update LRU tracking
          await this.updateLRU(cacheKey);
          
          logger.cache('cache_hit', cacheKey, true);
          return JSON.parse(value) as T;
        }

        if (this.config.enableMetrics) {
          this.metrics.misses++;
        }

        logger.cache('cache_miss', cacheKey, false);
        return null;
      });

    } catch (error) {
      this.metrics.errors++;
      logger.error('Cache get failed', error as Error, { cacheKey });
      return null; // Graceful degradation
    }
  }

  /**
   * Update LRU tracking for cache key
   */
  private async updateLRU(cacheKey: string): Promise<void> {
    const lruKey = 'cache:lru:queue';
    const now = Date.now();
    
    try {
      // Add to LRU queue with current timestamp
      await this.redis.zadd(lruKey, now.toString(), cacheKey);
      
      // Trim LRU queue to max size
      if (this.config.maxCacheSize) {
        await this.redis.zremrangebyrank(lruKey, 0, -this.config.maxCacheSize - 1);
      }
    } catch (error) {
      logger.error('LRU update failed', error as Error, { cacheKey });
    }
  }

  /**
   * Enforce memory limits by evicting least recently used entries
   */
  private async enforceMemoryLimits(): Promise<void> {
    try {
      const lruKey = 'cache:lru:queue';
      const keysToEvict = await this.redis.zrange(lruKey, 0, 99); // Get 100 oldest entries
      
      if (keysToEvict.length > 0) {
        // Delete oldest entries
        await this.redis.del(...keysToEvict);
        
        // Update metrics
        this.metrics.evictions += keysToEvict.length;
        
        logger.warn('Memory limit enforced, evicted entries', { 
          count: keysToEvict.length,
          keys: keysToEvict.slice(0, 5) // Log first 5 for debugging
        });
      }
    } catch (error) {
      this.metrics.errors++;
      logger.error('Memory limit enforcement failed', error as Error);
    }
  }

  /**
   * Delete cache entry with proper error handling
   */
  async delete(namespace: string, key: string): Promise<void> {
    const cacheKey = WebhookSecurity.generateCacheKey(namespace, key);
    
    try {
      await this.redis.del(cacheKey);
      logger.cache('cache_delete', cacheKey, true);
    } catch (error) {
      this.metrics.errors++;
      logger.error('Cache delete failed', error as Error, { cacheKey });
      throw error;
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
        logger.cache('cache_clear_namespace', namespace, true, { count: keys.length });
      }
    } catch (error) {
      this.metrics.errors++;
      logger.error('Cache clear namespace failed', error as Error, { namespace });
      throw error;
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
        this.metrics.errors++;
        logger.error('Cache cleanup job failed', error as Error);
      }
    }, this.config.cleanupInterval);

    // Cleanup on process exit
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
  }

  /**
   * Perform memory cleanup and metrics collection
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
          await this.enforceMemoryLimits();
        }

        // Clean up expired keys and update metrics
        await this.updateMetrics();
      });
    } catch (error) {
      this.metrics.errors++;
      logger.error('Cache cleanup failed', error as Error);
    }
  }

  /**
   * Update cache metrics
   */
  private async updateMetrics(): Promise<void> {
    try {
      const lruKey = 'cache:lru:queue';
      const totalEntries = await this.redis.zcard(lruKey);
      
      if (this.config.enableMetrics) {
        this.metrics.totalEntries = totalEntries;
      }
    } catch (error) {
      logger.error('Metrics update failed', error as Error);
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
   * Get cache metrics with enhanced information
   */
  getMetrics(): {
    hits: number;
    misses: number;
    evictions: number;
    memoryUsage: number;
    totalEntries: number;
    errors: number;
    hitRate: number;
    memoryPressure: boolean;
  } {
    const totalRequests = this.metrics.hits + this.metrics.misses;
    const hitRate = totalRequests > 0 ? this.metrics.hits / totalRequests : 0;
    const memoryPressure = this.metrics.memoryUsage > (this.config.maxMemoryUsage * 0.8);

    return {
      ...this.metrics,
      hitRate,
      memoryPressure
    };
  }

  /**
   * Get health status
   */
  getHealthStatus(): {
    healthy: boolean;
    issues: string[];
    metrics: any;
  } {
    const issues: string[] = [];
    const metrics = this.getMetrics();
    
    if (metrics.errors > 10) {
      issues.push('High error rate detected');
    }
    
    if (metrics.memoryPressure) {
      issues.push('Memory pressure detected');
    }
    
    if (metrics.hitRate < 0.5) {
      issues.push('Low cache hit rate');
    }
    
    if (metrics.evictions > 100) {
      issues.push('High eviction rate');
    }

    return {
      healthy: issues.length === 0,
      issues,
      metrics
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