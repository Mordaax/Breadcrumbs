import { logger } from './logger.js';

export function isEmail(value: string): boolean {
  const ok = /.+@.+\..+/.test(value);
  if (!ok) logger.warn(`invalid email: ${value}`);
  return ok;
}

export function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}
