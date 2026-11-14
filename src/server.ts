import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { startScheduler } from './jobs/scheduler';
import { checkBytidCredentials } from './lib/bytid';

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info(`RentCreeb API listening on :${env.PORT}`);
  startScheduler();
  void checkBytidCredentials();
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
