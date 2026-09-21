import { jevResponseSchema, type JevResponse } from "./schema.ts";

export const JEV_API_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

export type JevQuestions = Record<string, unknown>;

export type JevClientOptions = {
  apiKey: string;
  timeoutMilliseconds?: number;
  maxRetries?: number;
};

export class JevApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "JevApiError";
    if (status !== undefined) this.status = status;
  }
}

export class JevClient {
  readonly #apiKey: string;
  readonly #timeoutMilliseconds: number;
  readonly #maxRetries: number;

  constructor(options: JevClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new JevApiError("JEV_API_KEY is not set.");
    this.#apiKey = apiKey;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  async evaluate(state: unknown, questions: JevQuestions): Promise<JevResponse> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMilliseconds);
      try {
        const response = await fetch(JEV_API_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ state, model: JEV_MODEL, questions }),
          signal: controller.signal
        });

        if (response.ok) {
          const raw = (await response.json()) as unknown;
          const parsed = jevResponseSchema.safeParse(raw);
          if (!parsed.success) {
            throw new JevApiError("Jev returned a response that did not match its schema.");
          }
          return parsed.data;
        }

        if (isRetryable(response.status) && attempt < this.#maxRetries) {
          const delay = retryDelay(response.headers.get("retry-after"), attempt);
          await sleep(delay);
          continue;
        }

        throw await apiStatusError(response);
      } catch (error) {
        if (error instanceof JevApiError) throw error;
        if (isAbortError(error)) {
          throw new JevApiError(`Jev did not respond within ${this.#timeoutMilliseconds}ms.`);
        }
        throw new JevApiError("Could not reach the Jev API. Check network access.");
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new JevApiError("Jev request failed after retries.");
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

async function apiStatusError(response: Response): Promise<JevApiError> {
  const status = response.status;
  const errorType = await readErrorType(response);
  if (status === 400 && errorType === "max_tokens_exceeded") {
    return new JevApiError("Jev's input limit was exceeded. Reduce context size.", status);
  }
  if (status === 401) return new JevApiError("Jev rejected JEV_API_KEY.", status);
  if (status === 422) return new JevApiError("Jev rejected the request.", status);
  if (status === 429) return new JevApiError("Jev rate-limited the request.", status);
  if (status === 529) return new JevApiError("Jev remained overloaded.", status);
  return new JevApiError(`Jev API request failed with HTTP ${status}.`, status);
}

async function readErrorType(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as unknown;
    if (!isRecord(body) || !isRecord(body.detail)) return undefined;
    return typeof body.detail.error_type === "string" ? body.detail.error_type : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) return Math.min(Math.max(retryDate - Date.now(), 0), 5000);
  }
  return 250 * 2 ** attempt;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}