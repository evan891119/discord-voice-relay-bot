import { createSelfHostedBot } from './app.js';
import { createLogger } from './logger.js';

let logger = createLogger('info');
let bot;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await bot?.stop(signal);
  process.exit(0);
}

async function main() {
  process.once('SIGINT', (signal) => {
    void shutdown(signal);
  });
  process.once('SIGTERM', (signal) => {
    void shutdown(signal);
  });

  bot = createSelfHostedBot();
  await bot.start();
}

main().catch(async (error) => {
  logger.error('startup failed', {
    error: error.message,
    stack: error.stack,
  });
  await bot?.stop('startup-failed');
  process.exit(1);
});
