import { createLogger, format, transports, Logger } from 'winston';

/**
 * Structured Logging Service
 * Implements JSON logging for production observability
 */
export interface LogContext {
  requestId?: string;
  userId?: string;
  operation?: string;
  service?: string;
  component?: string;
}

export class StructuredLogger {
  private logger: Logger;
  private context: LogContext = {};

  constructor(serviceName: string = 'event-driven-integration-service') {
    this.logger = createLogger({
      level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
      format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        format.errors({ stack: true }),
        format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
        format.json()
      ),
      defaultMeta: {
        service: serviceName,
        environment: process.env.NODE_ENV || 'development',
        version: process.env.APP_VERSION || '1.0.0'
      },
      transports: [
        new transports.File({ 
          filename: 'logs/error.log', 
          level: 'error',
          maxsize: 50 * 1024 * 1024, // 50MB
          maxFiles: 10
        }),
        new transports.File({ 
          filename: 'logs/combined.log',
          maxsize: 50 * 1024 * 1024, // 50MB
          maxFiles: 10
        }),
      ],
    });

    // Add console transport for development
    if (process.env.NODE_ENV !== 'production') {
      this.logger.add(new transports.Console({
        format: format.combine(
          format.colorize(),
          format.simple()
        )
      }));
    }
  }

  /**
   * Set global context for all subsequent logs
   */
  setContext(context: LogContext): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Clear global context
   */
  clearContext(): void {
    this.context = {};
  }

  /**
   * Log with context
   */
  private logWithCtx(level: string, message: string, meta: any = {}): void {
    this.logger.log(level, message, {
      ...this.context,
      ...meta
    });
  }

  /**
   * Info level logging
   */
  info(message: string, meta: any = {}): void {
    this.logWithCtx('info', message, meta);
  }

  /**
   * Error level logging with stack trace
   */
  error(message: string, error?: Error, meta: any = {}): void {
    this.logWithCtx('error', message, {
      ...meta,
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : undefined
    });
  }

  /**
   * Warning level logging
   */
  warn(message: string, meta: any = {}): void {
    this.logWithCtx('warn', message, meta);
  }

  /**
   * Debug level logging
   */
  debug(message: string, meta: any = {}): void {
    this.logWithCtx('debug', message, meta);
  }

  /**
   * Performance logging
   */
  performance(operation: string, duration: number, meta: any = {}): void {
    this.logWithCtx('info', `Performance: ${operation}`, {
      ...meta,
      operation,
      duration,
      type: 'performance'
    });
  }

  /**
   * Security event logging
   */
  security(event: string, severity: 'low' | 'medium' | 'high' | 'critical', meta: any = {}): void {
    this.logWithCtx('warn', `Security: ${event}`, {
      ...meta,
      event,
      severity,
      type: 'security'
    });
  }

  /**
   * Business event logging
   */
  business(event: string, meta: any = {}): void {
    this.logWithCtx('info', `Business: ${event}`, {
      ...meta,
      event,
      type: 'business'
    });
  }

  /**
   * Webhook processing logging
   */
  webhook(provider: string, eventType: string, status: string, meta: any = {}): void {
    this.logWithCtx('info', `Webhook: ${provider} ${eventType} ${status}`, {
      ...meta,
      provider,
      eventType,
      status,
      type: 'webhook'
    });
  }

  /**
   * Cache operation logging
   */
  cache(operation: string, key: string, hit: boolean, meta: any = {}): void {
    this.logWithCtx('debug', `Cache: ${operation} ${key} ${hit ? 'HIT' : 'MISS'}`, {
      ...meta,
      operation,
      key,
      hit,
      type: 'cache'
    });
  }

  /**
   * Database operation logging
   */
  database(operation: string, table: string, duration: number, meta: any = {}): void {
    this.logWithCtx('info', `Database: ${operation} ${table}`, {
      ...meta,
      operation,
      table,
      duration,
      type: 'database'
    });
  }

  /**
   * External API logging
   */
  externalApi(service: string, endpoint: string, status: number, duration: number, meta: any = {}): void {
    this.logWithCtx('info', `External API: ${service} ${endpoint} ${status}`, {
      ...meta,
      service,
      endpoint,
      status,
      duration,
      type: 'external_api'
    });
  }

  /**
   * Health check logging
   */
  health(service: string, status: string, meta: any = {}): void {
    this.logWithCtx('info', `Health: ${service} ${status}`, {
      ...meta,
      service,
      status,
      type: 'health'
    });
  }

  /**
   * Circuit breaker logging
   */
  circuitBreaker(service: string, state: string, failures: number, meta: any = {}): void {
    this.logWithCtx('warn', `Circuit Breaker: ${service} ${state} failures:${failures}`, {
      ...meta,
      service,
      state,
      failures,
      type: 'circuit_breaker'
    });
  }

  /**
   * Get Winston logger instance for advanced usage
   */
  getWinstonLogger(): Logger {
    return this.logger;
  }
}

// Create singleton instance
export const logger = new StructuredLogger();