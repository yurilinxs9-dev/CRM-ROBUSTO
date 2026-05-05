import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, RedisClientType } from 'redis';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Socket.IO adapter that wires the Redis pub/sub adapter so multiple API
 * instances share the same room/event bus.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;

  constructor(app: INestApplicationContext) {
    super(app);
    this.app = app;
  }

  private readonly app: INestApplicationContext;

  async connectToRedis(): Promise<void> {
    const config = this.app.get(ConfigService);
    const url = config.get<string>('REDIS_URL');

    if (!url) {
      this.logger.warn('REDIS_URL not set — Socket.IO will run without Redis adapter');
      return;
    }

    const pubClient: RedisClientType = createClient({ url });
    const subClient: RedisClientType = pubClient.duplicate();

    pubClient.on('error', (err) => this.logger.error(`Redis pub error: ${String(err)}`));
    subClient.on('error', (err) => this.logger.error(`Redis sub error: ${String(err)}`));

    await Promise.all([pubClient.connect(), subClient.connect()]);
    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log('Socket.IO Redis adapter connected');
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options) as {
      adapter: (fn: unknown) => void;
    };
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
