import { cyan } from "./colors.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Run `task` while showing an animated spinner so a long await doesn't look
 * frozen. Spins only on a TTY; in a non-TTY (and not silent) it prints the label
 * once. `active: false` (e.g. JSON mode) stays completely silent. The label is
 * cleared when the task settles.
 */
export async function withSpinner<T>(
  label: string,
  task: () => Promise<T>,
  opts: { active?: boolean; intervalMs?: number } = {},
): Promise<T> {
  const active = opts.active ?? true;
  const stream = process.stdout;
  const spin = active && !!stream.isTTY;

  if (active && !spin) stream.write(label + "\n");
  const promise = task();
  if (!spin) return promise;

  let i = 0;
  const render = (): void => {
    i = (i + 1) % FRAMES.length;
    stream.write(`\r${cyan(FRAMES[i]!)} ${label}   `);
  };
  render();
  const timer = setInterval(render, opts.intervalMs ?? 80);
  if (typeof timer.unref === "function") timer.unref(); // don't keep the event loop alive
  try {
    return await promise;
  } finally {
    clearInterval(timer);
    stream.write("\r" + " ".repeat(label.length + 6) + "\r");
  }
}
