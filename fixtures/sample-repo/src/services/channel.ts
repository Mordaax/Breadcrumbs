import { logger } from '../utils/logger.js';
import { isNonEmpty } from '../utils/validation.js';
import { userService } from './user.js';

export interface Channel {
  name: string;
  ownerId: string;
  members: string[];
}

export class ChannelService {
  private channels: Channel[] = [];

  create(name: string, ownerId: string): Channel {
    if (!isNonEmpty(name)) throw new Error('channel name required');
    if (!userService.get(ownerId)) throw new Error('owner not found');
    const channel: Channel = { name, ownerId, members: [ownerId] };
    this.channels.push(channel);
    logger.info(`created channel ${name}`);
    return channel;
  }
}

export const channelService = new ChannelService();
