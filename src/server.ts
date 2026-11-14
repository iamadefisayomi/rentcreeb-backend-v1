
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { startScheduler } from './jobs/scheduler';
import { checkBytidCredentials } from './lib/bytid';

const app = createApp();

const PORT = Number(process.env.PORT) || env.PORT || 4000;
const HOST = '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  logger.info(`RentCreeb API listening on ${HOST}:${PORT}`);

  try {
    startScheduler();
  } catch (err) {
    logger.error({ err }, 'Failed to start scheduler');
  }

  void checkBytidCredentials().catch((err) => {
    logger.error({ err }, 'Bytid credential check failed');
  });
});

server.on('error', (err) => {
  logger.error({ err }, 'HTTP server error');
  process.exit(1);
});

const shutdown = (signal: string) => {
  logger.info(`${signal} received. Shutting down RentCreeb API...`);

  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error while closing HTTP server');
      process.exit(1);
    }

    logger.info('RentCreeb API shut down successfully');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
