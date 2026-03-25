import { createLogger, format, transports, Logger } from 'winston';
import { v4 as uuidv4 } from 'uuid';

interface LogContext {
  correlationId?: string;
  requestId?: string;
  userId?: string;
  provider?: string;
  operation?: string;
  [key: string]: any;
}

export class EnhancedLogger {
  private logger: Logger;
  private correlationId: string;

  constructor() {
    this.correlationId = uuidv4();
    this.logger = createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: format.combine(
        format.timestamp(),
        format.errors({ stack: true }),
        format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
        format.json()
      ),
      transports: [
        new transports.Console({
          format: format.combine(
            format.colorize(),
            format.simple()
          ),
        }),
        new transports.File({
          filename: 'logs/error.log',
          level: 'error',
          format: format.json(),
        }),
        new transports.File({
          filename: 'logs/combined.log',
          format: format.json(),
        }),
      ],
    });

    // Em produção, não mostre logs no console
    if (process.env.NODE_ENV === 'production') {
      this.logger.remove(this.logger.transports[0]);
    }
  }

  private generateCorrelationId(): string {
    return uuidv4();
  }

  private logWithCorrelation(
    level: string,
    message: string,
    context?: LogContext,
    error?: Error
  ): void {
    const logData = {
      correlationId: context?.correlationId || this.generateCorrelationId(),
      timestamp: new Date().toISOString(),
      level,
      message,
      context: {
        ...context,
        timestamp: new Date().toISOString(),
      },
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : undefined,
    };

    if (error) {
      this.logger.error(message, logData);
    } else {
      this.logger.log(level, message, logData);
    }
  }

  info(message: string, context?: LogContext): void {
    this.logWithCorrelation('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.logWithCorrelation('warn', message, context);
  }

  error(message: string, context?: LogContext, error?: Error): void {
    this.logWithCorrelation('error', message, context, error);
  }

  debug(message: string, context?: LogContext): void {
    this.logWithCorrelation('debug', message, context);
  }

  // Métodos específicos para diferentes tipos de operações
  logWebhookReceived(provider: string, eventType: string, correlationId?: string): void {
    this.info(`Webhook received from ${provider}`, {
      correlationId,
      provider,
      eventType,
      operationType: 'webhook_received',
    });
  }

  logWebhookProcessed(provider: string, eventType: string, status: string, correlationId?: string): void {
    this.info(`Webhook processed by ${provider}`, {
      correlationId,
      provider,
      eventType,
      status,
      operationType: 'webhook_processed',
    });
  }

  logWebhookError(provider: string, eventType: string, error: Error, correlationId?: string): void {
    this.error(`Webhook processing failed for ${provider}`, {
      correlationId,
      provider,
      eventType,
      operation: 'webhook_error',
    }, error);
  }

  logCacheOperation(operation: string, key: string, result: string, correlationId?: string): void {
    this.debug(`Cache ${operation} for key ${key}`, {
      correlationId,
      operation,
      key,
      result,
      operation: 'cache_operation',
    });
  }

  logDatabaseOperation(operation: string, table: string, status: string, correlationId?: string): void {
    this.debug(`Database ${operation} on ${table}`, {
      correlationId,
      operation,
      table,
      status,
      operation: 'database_operation',
    });
  }

  logSecurityEvent(event: string, details: any, correlationId?: string): void {
    this.warn(`Security event: ${event}`, {
      correlationId,
      event,
      details,
      operation: 'security_event',
    });
  }

  // Gerador de Correlation ID para middleware
  generateRequestCorrelationId(): string {
    return this.generateCorrelationId();
  }
}

// Instância singleton
export const enhancedLogger = new EnhancedLogger();

// Middleware para Express que adiciona Correlation ID
export function correlationIdMiddleware(req: any, res: any, next: any): void {
  const correlationId = req.headers['x-correlation-id'] || enhancedLogger.generateRequestCorrelationId();
  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);
  next();
}