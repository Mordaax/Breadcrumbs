// A tiny shared logger — imported widely, so it should rank as a top hub.
export type Level = 'debug' | 'info' | 'warn' | 'error';

export function log(level: Level, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${level}] ${msg}`);
}

export const logger = {
  debug: (m: string) => log('debug', m),
  info: (m: string) => log('info', m),
  warn: (m: string) => log('warn', m),
  error: (m: string) => log('error', m),
};
