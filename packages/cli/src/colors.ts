// Minimal ANSI color helpers. Disabled automatically when stdout isn't a TTY
// or NO_COLOR is set (https://no-color.org), so piped/captured output — and the
// test suite — stay plain. `--no-color` calls `disableColor()` from the CLI.

let enabled = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

export function disableColor(): void {
  enabled = false;
}

export function colorEnabled(): boolean {
  return enabled;
}

// Read `enabled` at call time (not capture time) so `disableColor()` takes
// effect even after these are defined.
function fg(open: number): (s: string) => string {
  return (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[39m` : s);
}
function attr(open: number, close: number): (s: string) => string {
  return (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const green = fg(32);
export const red = fg(31);
export const yellow = fg(33);
export const cyan = fg(36);
export const blue = fg(34);
export const gray = fg(90);
export const bold = attr(1, 22);
export const dim = attr(2, 22);
