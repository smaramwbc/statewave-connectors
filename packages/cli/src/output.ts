import { dim, red, yellow } from "./colors.js";

export interface OutputOptions {
  json?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export class Output {
  private readonly json: boolean;
  private readonly out: NodeJS.WritableStream;
  private readonly err: NodeJS.WritableStream;

  constructor(opts: OutputOptions = {}) {
    this.json = !!opts.json;
    this.out = opts.stdout ?? process.stdout;
    this.err = opts.stderr ?? process.stderr;
  }

  isJson(): boolean {
    return this.json;
  }

  log(message: string): void {
    if (this.json) return;
    this.out.write(message + "\n");
  }

  warn(message: string): void {
    this.err.write(`${yellow("warn:")} ${message}\n`);
  }

  error(message: string, hint?: string): void {
    if (this.json) {
      this.out.write(JSON.stringify({ error: message, hint }) + "\n");
      return;
    }
    this.err.write(`${red("error:")} ${message}\n`);
    if (hint) this.err.write(`${dim("hint: ")} ${hint}\n`);
  }

  data(payload: unknown): void {
    if (this.json) {
      this.out.write(JSON.stringify(payload, null, 2) + "\n");
    }
  }
}
