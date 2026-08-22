import { handleRequest } from './api/routes.js';
import { logger } from './utils/logger.js';

export async function main(): Promise<void> {
  logger.info('starting sample app');
  await handleRequest('/users');
  await handleRequest('/channels');
}

main().catch((e) => logger.error(String(e)));
