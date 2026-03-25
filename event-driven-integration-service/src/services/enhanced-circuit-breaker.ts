import { CircuitBreakerFactory, CircuitBreaker } from './circuit-breaker';
import { enhancedLogger } from './enhanced-logger';

export interface WebhookProviderConfig {
  name: string;
  failureThreshold: number;
  resetTimeout: number;
  monitoringPeriod: number;
  maxQueueSize: number;
}

export interface WebhookRequest {
  provider: string;
  eventType: string;
  payload: any;
  signature: string;
  correlationId?: string;
}

export interface DeadLetterQueueItem extends WebhookRequest {
  timestamp: Date;
  retryCount: number;
  lastError?: string;
}

export class EnhancedCircuitBreakerManager {
  private circuitBreakers: Map<string, any> = new Map();
  private deadLetterQueues: Map<string, DeadLetterQueueItem[]> = new Map();
  private configs: Map<string, WebhookProviderConfig> = new Map();

  constructor() {
    this.initializeProviders();
  }

  private initializeProviders(): void {
    const defaultConfig: WebhookProviderConfig = {
      name: 'default',
      failureThreshold: 5,
      resetTimeout: 30000, // 30 seconds
      monitoringPeriod: 60000, // 1 minute
      maxQueueSize: 100,
    };

    this.setProviderConfig('stripe', {
      ...defaultConfig,
      name: 'stripe',
      failureThreshold: 3,
      resetTimeout: 60000, // 1 minute for financial transactions
      maxQueueSize: 50,
    });

    this.setProviderConfig('paypal', {
      ...defaultConfig,
      name: 'paypal',
      failureThreshold: 4,
      resetTimeout: 45000,
      maxQueueSize: 75,
    });

    this.setProviderConfig('github', {
      ...defaultConfig,
      name: 'github',
      failureThreshold: 6,
      resetTimeout: 20000, // Faster recovery for dev tools
      maxQueueSize: 200,
    });
  }

  setProviderConfig(provider: string, config: WebhookProviderConfig): void {
    this.configs.set(provider, config);
    
    // Cria circuit breaker baseado no provider
    let cb: CircuitBreaker<any>;
    if (provider === 'stripe') {
      cb = CircuitBreakerFactory.createStripeBreaker(async () => {
        // Operação mock para o circuit breaker
        return { success: true };
      });
    } else if (provider === 'paypal') {
      cb = CircuitBreakerFactory.createPayPalBreaker(async () => {
        return { success: true };
      });
    } else {
      cb = CircuitBreakerFactory.createDatabaseBreaker(async () => {
        return { success: true };
      });
    }

    this.circuitBreakers.set(provider, cb);

    // Configura eventos do circuit breaker
    // Note: A implementação atual do CircuitBreaker não tem eventos, 
    // então vamos simular o comportamento
    const originalExecute = cb.execute.bind(cb);
    cb.execute = async () => {
      const state = cb.getState();
      if (state === 'OPEN') {
        enhancedLogger.warn(`Circuit breaker opened for ${provider}`, {
          provider,
          operation: 'circuit_breaker_opened',
        });
      } else if (state === 'CLOSED') {
        enhancedLogger.info(`Circuit breaker closed for ${provider}`, {
          provider,
          operation: 'circuit_breaker_closed',
        });
      }
      return originalExecute();
    };
  }

  async executeWithCircuitBreaker<T>(
    provider: string,
    operation: () => Promise<T>,
    request: WebhookRequest
  ): Promise<T> {
    const cb = this.circuitBreakers.get(provider);
    const config = this.configs.get(provider);

    if (!cb || !config) {
      throw new Error(`No circuit breaker configured for provider: ${provider}`);
    }

    try {
      // Verifica se o circuit breaker está aberto
      if (cb.state === 'open') {
        enhancedLogger.warn(`Circuit breaker is open for ${provider}, queuing request`, {
          provider,
          correlationId: request.correlationId,
          operation: 'request_queued',
        });

        // Enfileira a requisição na Dead Letter Queue
        this.enqueueDeadLetter(provider, {
          ...request,
          timestamp: new Date(),
          retryCount: 0,
          lastError: 'Circuit breaker is open',
        });

        throw new Error(`Service temporarily unavailable for ${provider}. Request queued for retry.`);
      }

      // Executa a operação com o circuit breaker
      const result = await cb.execute();
      
      enhancedLogger.info(`Operation successful for ${provider}`, {
        provider,
        correlationId: request.correlationId,
        operation: 'operation_success',
      });

      return result;
    } catch (error) {
      enhancedLogger.error(`Operation failed for ${provider}`, {
        provider,
        correlationId: request.correlationId,
        operation: 'operation_failed',
      }, error as Error);

      // Enfileira a requisição na Dead Letter Queue
      this.enqueueDeadLetter(provider, {
        ...request,
        timestamp: new Date(),
        retryCount: 0,
        lastError: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  private enqueueDeadLetter(provider: string, item: DeadLetterQueueItem): void {
    const queue = this.deadLetterQueues.get(provider) || [];
    const config = this.configs.get(provider);

    if (!config) return;

    // Remove itens mais antigos se a fila estiver cheia
    if (queue.length >= config.maxQueueSize) {
      const removed = queue.shift();
      enhancedLogger.warn(`DLQ full for ${provider}, removing oldest item`, {
        provider,
        removedTimestamp: removed?.timestamp,
        operation: 'dlq_item_removed',
      });
    }

    queue.push(item);
    this.deadLetterQueues.set(provider, queue);

    enhancedLogger.info(`Request queued in DLQ for ${provider}`, {
      provider,
      queueSize: queue.length,
      correlationId: item.correlationId,
      operation: 'dlq_item_added',
    });
  }

  async processDeadLetterQueue(provider: string): Promise<void> {
    const queue = this.deadLetterQueues.get(provider) || [];
    const config = this.configs.get(provider);
    const cb = this.circuitBreakers.get(provider);

    if (!config || !cb) return;

    const processed: number[] = [];
    const now = new Date();

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];

      // Verifica se já tentou muitas vezes
      if (item.retryCount >= 3) {
        enhancedLogger.error(`Max retries exceeded for ${provider} request`, {
          provider,
          correlationId: item.correlationId,
          retryCount: item.retryCount,
          operation: 'max_retries_exceeded',
        });
        processed.push(i);
        continue;
      }

      // Verifica se passou tempo suficiente desde a última tentativa
      const timeSinceLastAttempt = now.getTime() - item.timestamp.getTime();
      const minRetryInterval = 60000; // 1 minute

      if (timeSinceLastAttempt < minRetryInterval) {
        continue;
      }

      try {
        // Tenta processar novamente
        await this.executeWithCircuitBreaker(provider, async () => {
          // Simula o processamento da requisição
          return this.processWebhookRequest(item);
        }, item);

        // Se sucesso, remove da fila
        processed.push(i);
        enhancedLogger.info(`Successfully processed queued request for ${provider}`, {
          provider,
          correlationId: item.correlationId,
          retryCount: item.retryCount,
          operation: 'dlq_item_processed',
        });

      } catch (error) {
        // Atualiza a contagem de tentativas e o timestamp
        item.retryCount++;
        item.timestamp = new Date();
        item.lastError = error instanceof Error ? error.message : 'Unknown error';

        enhancedLogger.warn(`Failed to process queued request for ${provider}`, {
          provider,
          correlationId: item.correlationId,
          retryCount: item.retryCount,
          operation: 'dlq_item_retry_failed',
        }, error as Error);
      }
    }

    // Remove itens processados da fila
    for (let i = processed.length - 1; i >= 0; i--) {
      queue.splice(processed[i], 1);
    }

    this.deadLetterQueues.set(provider, queue);
  }

  private async processWebhookRequest(item: DeadLetterQueueItem): Promise<any> {
    // Simula o processamento da requisição webhook
    // Esta seria a lógica real de processamento que falhou anteriormente
    enhancedLogger.info(`Processing webhook request for ${item.provider}`, {
      provider: item.provider,
      eventType: item.eventType,
      correlationId: item.correlationId,
      operation: 'webhook_processing',
    });

    // Simula sucesso (na implementação real, seria o processamento real)
    return { success: true, provider: item.provider };
  }

  getQueueStatus(provider: string): { size: number; oldestItem?: Date; newestItem?: Date } {
    const queue = this.deadLetterQueues.get(provider) || [];
    return {
      size: queue.length,
      oldestItem: queue.length > 0 ? queue[0].timestamp : undefined,
      newestItem: queue.length > 0 ? queue[queue.length - 1].timestamp : undefined,
    };
  }

  async processAllQueues(): Promise<void> {
    for (const [provider] of this.circuitBreakers) {
      await this.processDeadLetterQueue(provider);
    }
  }

  // Método para limpar filas antigas
  cleanupOldQueueItems(provider: string, maxAgeHours: number = 24): void {
    const queue = this.deadLetterQueues.get(provider) || [];
    const cutoffTime = new Date(Date.now() - (maxAgeHours * 60 * 60 * 1000));
    const originalSize = queue.length;

    const filteredQueue = queue.filter(item => item.timestamp > cutoffTime);
    this.deadLetterQueues.set(provider, filteredQueue);

    const removedCount = originalSize - filteredQueue.length;
    if (removedCount > 0) {
      enhancedLogger.info(`Cleaned up ${removedCount} old items from DLQ for ${provider}`, {
        provider,
        removedCount,
        operation: 'dlq_cleanup',
      });
    }
  }
}

// Instância singleton
export const enhancedCircuitBreakerManager = new EnhancedCircuitBreakerManager();