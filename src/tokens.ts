/**
 * tokens.ts — token estimation.
 *
 * We deliberately avoid a hard dependency on a tokenizer library. For the
 * purpose of *budgeting* context for an LLM agent, an approximation is enough:
 * the goal is to compare full-repo cost vs. packed cost and to stop including
 * files once a budget is exhausted, not to bill anyone exactly.
 *
 * The heuristic `chars / 4` is the well-known rule of thumb for English / code
 * with BPE tokenizers (GPT-style and Claude-style tokenizers land close to
 * this for source code). We expose the divisor so it can be tuned, and leave a
 * documented seam (`setTokenizer`) for swapping in a real tokenizer later
 * without touching call sites.
 */

export type TokenCounter = (text: string) => number;

const CHARS_PER_TOKEN = 4;

/** Default estimator: characters divided by an average chars-per-token ratio. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

let activeCounter: TokenCounter = estimateTokens;

/**
 * Swap the active token counter. Deferred work (a real tokenizer such as
 * `tiktoken` or `@anthropic-ai/tokenizer`) can register here without changing
 * any caller. Returns the previously active counter so tests can restore it.
 */
export function setTokenizer(counter: TokenCounter): TokenCounter {
  const previous = activeCounter;
  activeCounter = counter;
  return previous;
}

/** Count tokens using whatever counter is currently active. */
export function countTokens(text: string): number {
  return activeCounter(text);
}

/** Human-friendly formatting for token counts (1234 -> "1,234"). */
export function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** Percentage of tokens saved going from `full` to `packed`. */
export function percentSaved(full: number, packed: number): number {
  if (full <= 0) return 0;
  const saved = ((full - packed) / full) * 100;
  return Math.round(saved * 10) / 10;
}
