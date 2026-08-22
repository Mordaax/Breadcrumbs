// Uses CommonJS require + dynamic import to exercise the parser's other paths.
const { logger } = require('../utils/logger.js');
import { userService } from '../services/user.js';
import { channelService } from '../services/channel.js';

export async function handleRequest(path: string): Promise<unknown> {
  logger.info(`request ${path}`);
  if (path === '/users') {
    const user = userService.register('alice', 'alice@example.com');
    // Dynamic import path — parser should detect this too.
    const { Channel } = await import('../services/channel.js');
    void Channel;
    return user;
  }
  if (path === '/channels') {
    const u = userService.register('bob', 'bob@example.com');
    return channelService.create('general', u.id);
  }
  return { error: 'not found' };
}
