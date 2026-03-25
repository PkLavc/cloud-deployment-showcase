import express from 'express';
import { logger } from '../services/logger';

/**
 * Stripe Webhook Retry Middleware with Exponential Backoff
 * Garante que falhas temporárias não resultem em perda de dados
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  retryableErrors: string[];
  jitter: boolean;
}

export interface WebhookRetryContext {
  attempt: number;
  originalPayload: Buffer;
  originalHeaders: Record<string, string | string[] | undefined>;
  retryCount: number;
  lastError?: Error;
}

export class StripeRetryMiddleware {
  private config: RetryConfig;
  private retryQueue: Map<string, WebhookRetryContext> = new Map();
  private processingQueue: Set<string> = new Set();

  constructor(config?: Partial<RetryConfig>) {
    this.config = {
      maxRetries: 3,
      baseDelay: 1000, // 1 segundo
      maxDelay: 30000, // 30 segundos
      retryableErrors: [
        'ECONNRESET',
        'ENETUNREACH', 
        'ETIMEDOUT',
        'ECONNREFUSED',
        'EHOSTUNREACH',
        '500',
        '502',
        '503',
        '504'
      ],
      jitter: true,
      ...config
    };
  }

  /**
   * Middleware para processamento de webhooks com retry
   */
  public processWithRetry() {
    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const requestId = this.generateRequestId(req);
      const signature = req.headers['stripe-signature'] as string;

      // Verifica se já estamos processando este webhook
      if (this.processingQueue.has(requestId)) {
        logger.warn(`Duplicate webhook request detected: ${requestId}`);
        return res.status(409).json({ 
          success: false,
          error: 'Duplicate request', 
          message: 'This webhook is already being processed',
          requestId
        });
      }

      const context: WebhookRetryContext = {
        attempt: 0,
        originalPayload: req.body,
        originalHeaders: req.headers,
        retryCount: 0
      };

      this.processingQueue.add(requestId);
      this.retryQueue.set(requestId, context);

      try {
        const result = await this.processWithRetryLogic(req, res, requestId, context);
        this.cleanupRequest(requestId);
        return result;
      } catch (error) {
        this.cleanupRequest(requestId);
        return this.handleProcessingError(error, res, requestId);
      }
    };
  }

  private async processWithRetryLogic(
    req: express.Request, 
    res: express.Response, 
    requestId: string, 
    context: WebhookRetryContext
  ): Promise<any> {
    const maxRetries = this.config.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      context.attempt = attempt;
      context.retryCount = attempt - 1;

      try {
        logger.info(`Processing webhook attempt ${attempt}/${maxRetries}`, { 
          retryCount: context.retryCount 
        });

        // Processa o webhook normalmente
        const result = await this.processWebhook(req, res);
        
        if (result) {
          logger.info(`Webhook processed successfully on attempt ${attempt}`, { requestId });
          return result;
        }

      } catch (error) {
        lastError = error as Error;
        logger.error(`Webhook processing failed on attempt ${attempt}`);

        // Verifica se o erro é retryable
        if (!this.isRetryableError(error)) {
          logger.error(`Non-retryable error occurred, stopping retries`);
          throw error;
        }

        // Se não for a última tentativa, aguarda antes de tentar novamente
        if (attempt < maxRetries) {
          const delay = this.calculateDelay(attempt);
          logger.info(`Waiting ${delay}ms before retry ${attempt + 1}`, { requestId, delay });
          
          await this.delay(delay);
          
          // Reconstitui a requisição para a próxima tentativa
          this.rebuildRequest(req, context);
        }
      }
    }

    // Todas as tentativas falharam
    throw new Error(`Webhook processing failed after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
  }

  private async processWebhook(req: express.Request, res: express.Response): Promise<any> {
    // Importa o processamento real do webhook (será injetado)
    // Esta é uma implementação mock para demonstração
    const signature = req.headers['stripe-signature'] as string;
    const body = req.body;

    // Simula o processamento do webhook
    if (!signature) {
      throw new Error('Missing Stripe signature');
    }

    // Simula falhas temporárias
    if (Math.random() < 0.3) { // 30% de chance de falha temporária
      throw new Error('ECONNRESET: Temporary connection failure');
    }

    // Simula processamento bem-sucedido
    return { success: true, received: true, processedAt: new Date().toISOString() };
  }

  private isRetryableError(error: any): boolean {
    const errorString = error.code || error.message || error.toString();
    
    return this.config.retryableErrors.some(retryableError => 
      errorString.includes(retryableError) || 
      errorString.toLowerCase().includes(retryableError.toLowerCase())
    );
  }

  private calculateDelay(attempt: number): number {
    // Exponential backoff: baseDelay * 2^(attempt-1)
    let delay = this.config.baseDelay * Math.pow(2, attempt - 1);
    
    // Limita ao maxDelay
    delay = Math.min(delay, this.config.maxDelay);
    
    // Adiciona jitter para evitar thundering herd
    if (this.config.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }
    
    return Math.floor(delay);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private generateRequestId(req: express.Request): string {
    const signature = req.headers['stripe-signature'] as string;
    const timestamp = Date.now();
    const payloadHash = require('crypto')
      .createHash('sha256')
      .update(req.body)
      .digest('hex');
    
    return `stripe_${timestamp}_${payloadHash.substring(0, 8)}`;
  }

  private rebuildRequest(req: express.Request, context: WebhookRetryContext): void {
    // Reconstitui o body e headers para a próxima tentativa
    req.body = context.originalPayload;
    Object.assign(req.headers, context.originalHeaders);
  }

  private cleanupRequest(requestId: string): void {
    this.retryQueue.delete(requestId);
    this.processingQueue.delete(requestId);
  }

  private handleProcessingError(error: any, res: express.Response, requestId: string): any {
    const statusCode = error.statusCode || error.status || 500;
    const errorMessage = error.message || 'Internal server error';

    logger.error('Final webhook processing failure');

    // Registra o webhook falhado para possível processamento manual posterior
    this.logFailedWebhook(requestId, error);

    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      requestId,
      timestamp: new Date().toISOString()
    });
  }

  private logFailedWebhook(requestId: string, error: Error): void {
    // Em produção, isso deveria ir para uma dead letter queue ou sistema de alerta
    logger.error('Webhook failed permanently and should be investigated');
  }

  /**
   * Endpoint para monitoramento de webhooks em retry
   */
  public getRetryStatus(): { processing: number; queued: number; failed: string[] } {
    return {
      processing: this.processingQueue.size,
      queued: this.retryQueue.size,
      failed: [] // Em implementação real, retornaria webhooks falhados permanentemente
    };
  }

  /**
   * Limpa webhooks falhados (para testes ou manutenção)
   */
  public clearFailedWebhooks(): void {
    this.retryQueue.clear();
    this.processingQueue.clear();
    logger.info('Cleared all failed webhook records');
  }
}

// Instância singleton do middleware
export const stripeRetryMiddleware = new StripeRetryMiddleware({
  maxRetries: 5,
  baseDelay: 2000, // 2 segundos
  maxDelay: 60000, // 1 minuto
  jitter: true
});

// Exporta o middleware pronto para uso
export const stripeWebhookRetry = stripeRetryMiddleware.processWithRetry();