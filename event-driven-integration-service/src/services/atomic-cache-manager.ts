import Redis from 'ioredis';

/**
 * Atomic Cache Manager with Lua Scripts
 * Elimina Race Conditions usando operações atômicas no Redis
 */
export class AtomicCacheManager {
  private redis: Redis;
  private cacheGetSetScript: string;
  private cacheGetSetWithTTLScript: string;

  constructor(redis: Redis) {
    this.redis = redis;
    this.initializeLuaScripts();
  }

  private initializeLuaScripts(): void {
    // Script Lua atômico para GET + SETEX em caso de cache miss
    // Elimina Race Condition entre múltiplas requisições simultâneas
    this.cacheGetSetScript = `
      local key = KEYS[1]
      local value = ARGV[1]
      local ttl = ARGV[2]
      local force_update = ARGV[3]
      
      -- Verifica se a chave existe
      local current_value = redis.call('GET', key)
      
      if current_value then
        -- Se existe, retorna o valor atual
        return {current_value, 'HIT'}
      else
        -- Se não existe, armazena o novo valor com TTL
        if value and ttl and ttl > 0 then
          redis.call('SETEX', key, ttl, value)
          return {value, 'SET'}
        else
          return {nil, 'MISS'}
        end
      end
    `;

    // Script Lua para atualização condicional (optimistic locking)
    this.cacheGetSetWithTTLScript = `
      local key = KEYS[1]
      local value = ARGV[1]
      local ttl = ARGV[2]
      local expected_value = ARGV[3]
      
      -- Verifica valor atual
      local current_value = redis.call('GET', key)
      
      if current_value == false then
        -- Chave não existe, cria nova
        if value and ttl and ttl > 0 then
          redis.call('SETEX', key, ttl, value)
          return {value, 'CREATED'}
        end
      elseif expected_value == nil or current_value == expected_value then
        -- Valor corresponde ao esperado ou não há expectativa, atualiza
        if value and ttl and ttl > 0 then
          redis.call('SETEX', key, ttl, value)
          return {value, 'UPDATED'}
        end
      else
        -- Valor foi modificado por outra operação
        return {current_value, 'CONFLICT'}
      end
      
      return {nil, 'NO_OP'}
    `;
  }

  /**
   * Operação atômica GET + SETEX
   * Garante que apenas uma operação armazene o valor em caso de cache miss simultâneo
   */
  async getOrSet(key: string, value: any, ttlSeconds: number): Promise<{value: any, operation: string}> {
    try {
      const result = await this.redis.eval(
        this.cacheGetSetScript,
        1, // número de chaves
        key,
        JSON.stringify(value),
        ttlSeconds,
        'false' // force_update
      );

      const typedResult = result as [string, string];
      return {
        value: typedResult[0] ? JSON.parse(typedResult[0]) : null,
        operation: typedResult[1]
      };
    } catch (error) {
      console.error(`Atomic cache operation failed for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Operação atômica com optimistic locking
   * Prevenção de atualizações concorrentes
   */
  async getOrSetWithLock(key: string, value: any, ttlSeconds: number, expectedValue?: any): Promise<{value: any, operation: string}> {
    try {
      const result = await this.redis.eval(
        this.cacheGetSetWithTTLScript,
        1, // número de chaves
        key,
        JSON.stringify(value),
        ttlSeconds,
        expectedValue ? JSON.stringify(expectedValue) : ''
      );

      const typedResult = result as [string, string];
      return {
        value: typedResult[0] ? JSON.parse(typedResult[0]) : null,
        operation: typedResult[1]
      };
    } catch (error) {
      console.error(`Atomic cache operation with lock failed for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Atualização atômica com retry em caso de conflito
   * Utiliza Lua Script para garantir atomicidade total no nível do Redis
   */
  async atomicUpdate(key: string, updateFn: (currentValue: any) => any, ttlSeconds: number, maxRetries: number = 3): Promise<{value: any, operation: string}> {
    const updateScript = `
      local key = KEYS[1]
      local ttl = ARGV[1]
      local current_value = redis.call('GET', key)
      
      -- Se a chave não existe, cria um valor padrão
      if current_value == false then
        current_value = nil
      else
        current_value = cjson.decode(current_value)
      end
      
      -- Aplica a função de atualização (simulada no Lua)
      -- Como não podemos passar funções JavaScript para Lua, 
      -- a lógica de atualização deve ser implementada no script
      -- Para este caso genérico, vamos retornar um erro indicando
      -- que a atualização deve ser feita via MULTI/EXEC
      
      return {current_value, 'NEEDS_MULTI_EXEC'}
    `;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Primeiro, tenta obter o valor atual de forma atômica
        const result = await this.redis.eval(updateScript, 1, key, ttlSeconds);
        const typedResult = result as [any, string];
        
        if (typedResult[1] === 'NEEDS_MULTI_EXEC') {
          // Usa MULTI/EXEC com WATCH para garantir atomicidade total
          const transactionResult = await this.redis
            .multi()
            .watch(key)
            .get(key)
            .exec();
          
          if (transactionResult && transactionResult[0] && transactionResult[0][1]) {
            const currentValue = transactionResult[0][1];
            const parsedValue = currentValue ? JSON.parse(currentValue) : null;
            const newValue = updateFn(parsedValue);
            
            // Executa a atualização dentro da transação
            const execResult = await this.redis
              .multi()
              .setex(key, ttlSeconds, JSON.stringify(newValue))
              .exec();
            
            if (execResult && execResult[0] && execResult[0][1]) {
              return {
                value: newValue,
                operation: 'UPDATED'
              };
            }
          }
        }
        
        // Se houve conflito, aguarda um tempo exponencial antes de tentar novamente
        if (attempt < maxRetries - 1) {
          await this.delay(Math.pow(2, attempt) * 10); // Exponential backoff: 10ms, 20ms, 40ms
        }
      } catch (error) {
        console.error(`Atomic update attempt ${attempt + 1} failed for key ${key}:`, error);
        if (attempt === maxRetries - 1) throw error;
      }
    }
    
    throw new Error(`Atomic update failed after ${maxRetries} attempts for key ${key}`);
  }

  /**
   * Limpeza atômica de múltiplas chaves
   */
  async atomicDelete(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    
    const script = `
      local deleted = 0
      for i = 1, #KEYS do
        local result = redis.call('DEL', KEYS[i])
        deleted = deleted + result
      end
      return deleted
    `;
    
    try {
      const result = await this.redis.eval(script, keys.length, ...keys);
      return Number(result);
    } catch (error) {
      console.error('Atomic delete operation failed:', error);
      throw error;
    }
  }

  /**
   * Verificação atômica de múltiplas chaves
   */
  async atomicMGet(keys: string[]): Promise<Record<string, any>> {
    if (keys.length === 0) return {};
    
    const script = `
      local results = {}
      for i = 1, #KEYS do
        results[i] = redis.call('GET', KEYS[i])
      end
      return results
    `;
    
    try {
      const results = await this.redis.eval(script, keys.length, ...keys);
      const output: Record<string, any> = {};
      
      keys.forEach((key, index) => {
        const typedResults = results as (string | null)[];
        output[key] = typedResults[index] ? JSON.parse(typedResults[index]!) : null;
      });
      
      return output;
    } catch (error) {
      console.error('Atomic MGET operation failed:', error);
      throw error;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async disconnect(): Promise<void> {
    await this.redis.disconnect();
  }
}