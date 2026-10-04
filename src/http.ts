import type { Config } from './config.js';
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Fetch = typeof fetch;
export class HttpClient {
  private next = 0;
  constructor(
    private config: Config['http'],
    private agent: string,
    private transport: Fetch = fetch,
    private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {}
  async json(url: string, init: RequestInit = {}): Promise<any> {
    for (let attempt = 0; attempt < this.config.attempts; attempt++) {
      // Reserve a slot before yielding so concurrent callers cannot start in a burst.
      const start = Math.max(this.next, Date.now());
      this.next = start + this.config.intervalMs;
      await this.sleep(Math.max(0, start - Date.now()));
      try {
        const response = await this.transport(url, {
          ...init,
          headers: { 'User-Agent': this.agent, Accept: 'application/json', ...init.headers },
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) {
            const retry = response.headers.get('retry-after');
            const wait = retry
              ? Number.isFinite(Number(retry))
                ? Number(retry) * 1000
                : Math.max(0, Date.parse(retry) - Date.now())
              : this.config.backoffMs * 2 ** attempt;
            if (attempt + 1 < this.config.attempts) {
              await this.sleep(wait);
              continue;
            }
          }
          throw new HttpError(
            response.status,
            `HTTP ${response.status} from ${new URL(url).hostname}`,
          );
        }
        const body = await response.json();
        if (body?.error) {
          if (
            ['maxlag', 'ratelimited'].includes(body.error.code) &&
            attempt + 1 < this.config.attempts
          ) {
            await this.sleep(this.config.backoffMs * 2 ** attempt);
            continue;
          }
          throw Error(`API error: ${body.error.code}`);
        }
        return body;
      } catch (e) {
        if (e instanceof HttpError || attempt + 1 === this.config.attempts) throw e;
        await this.sleep(this.config.backoffMs * 2 ** attempt);
      }
    }
    throw Error('HTTP retry budget exhausted');
  }
}
