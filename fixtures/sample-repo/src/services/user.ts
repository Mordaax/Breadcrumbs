import { logger } from '../utils/logger.js';
import { isEmail, isNonEmpty } from '../utils/validation.js';
import { createUser, type User } from '../models/user.model.js';
import { userRepository } from '../db/repository.js';

export class UserService {
  register(username: string, email: string): User {
    if (!isNonEmpty(username)) throw new Error('username required');
    if (!isEmail(email)) throw new Error('invalid email');
    const user = createUser({ username, email });
    userRepository.save(user);
    logger.info(`registered ${user.username}`);
    return user;
  }

  get(id: string): User | undefined {
    return userRepository.findById(id);
  }
}

export const userService = new UserService();
