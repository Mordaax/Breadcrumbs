import { logger } from '../utils/logger.js';
import type { User } from '../models/user.model.js';

// Pretend in-memory store standing in for a Mongo collection.
const store = new Map<string, User>();

export const userRepository = {
  save(user: User): User {
    store.set(user.id, user);
    logger.debug(`saved user ${user.id}`);
    return user;
  },
  findById(id: string): User | undefined {
    return store.get(id);
  },
  all(): User[] {
    return [...store.values()];
  },
};
