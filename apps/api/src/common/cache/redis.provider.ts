import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

const logger = new Logger('RedisProvider');

export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (config: ConfigService): Redis => {
    const host = config.get<string>('REDIS_HOST', '127.0.0.1');
    const port = Number(config.get<string>('REDIS_PORT', '6379'));

    const client = new Redis({
      host,
      port,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      enableOfflineQueue: false,
    });

    client.on('connect', () => logger.log(`Connected to Redis at ${host}:${port}`));
    client.on('error', (err) => logger.error(`Redis error: ${err.message}`));
    client.on('close', () => logger.warn('Redis connection closed'));

    return client;
  },
  inject: [ConfigService],
};
