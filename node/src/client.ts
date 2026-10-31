/**
 * The FynePDF API client: one object, `new FynePDF()`, with files, jobs, every
 * PDF action, AI and account calls. No dependencies; Node 18+ (or any runtime
 * with fetch, FormData and Blob).
 */
import {
  ACTION_ROUTES,
  type AskPdfRequest,
  type AskPdfResponse,
  type CreateFileResponse,
  type CreateJobRequest,
  type EditPdfRequest,
  type EditPdfResponse,
  type ExtractDataRequest,
  type ExtractDataResponse,
  type File as FynePDFFile,
  type FindRedactionsRequest,
  type FindRedactionsResponse,
  type GetBalanceResponse,
  type GetMeResponse,
  type Job,
  type ListActionsResponse,
  type PdfActions,
  type Problem,
  type Quote,
  type QuoteJobRequest,
  type SummarizePdfRequest,
  type SummarizePdfResponse,
} from "./generated.js";

export const VERSION = "0.1.0";
const DEFAULT_BASE_URL = "https://api.fynepdf.com/v1";
/** Larger files go through an upload URL instead of the request body. */
const MULTIPART_LIMIT = 25 * 1000 * 1000;
const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

export interface ClientOptions {
  /** Defaults to the FYNEPDF_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to https://api.fynepdf.com/v1. */
  baseUrl?: string;
  /** Per request, in milliseconds (default 120 000: a call can wait 60 s for its job). */
  timeoutMs?: number;
  /** Retries for rate limits, timeouts and server errors (default 2). */
  maxRetries?: number;
  /** A fetch to use instead of the global one. */
  fetch?: typeof fetch;
}

/** An error the API answered with: its problem details, ready to branch on. */
export class FynePDFError extends Error {
  readonly status: number;
  /** A stable code: insufficient_credits, validation_failed, rate_limited… */
  readonly code: string;
  readonly detail: string;
  readonly requestId?: string;
  readonly errors?: { path: string; message: string }[];
  readonly problem?: Problem;

  constructor(status: number, problem: Partial<Problem> | undefined, fallback: string) {
    super(problem?.detail ?? fallback);
    this.name = "FynePDFError";
    this.status = status;
    this.code = problem?.code ?? (status ? `http_${status}` : "network_error");
    this.detail = problem?.detail ?? fallback;
    this.requestId = problem?.request_id;
    this.errors = problem?.errors;
    this.problem = problem as Problem | undefined;
  }
}

/** A file to add: a path (Node), bytes, or a Blob, with a name when it has none. */
export type Uploadable = string | Uint8Array | ArrayBuffer | Blob;

export interface UploadOptions {
  /** Needed for bytes; taken from the path or the File otherwise. */
  filename?: string;
  /** Seconds to keep it (300 to 86 400, the default). */
  ttl_seconds?: number;
}

interface RequestOptions {
  body?: unknown;
  form?: FormData;
  query?: Record<string, string | number | undefined>;
  /** A fixed Idempotency-Key; POSTs get a fresh one by default, reused across retries. */
  idempotencyKey?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  epub: "application/epub+zip",
  html: "text/html",
  md: "text/markdown",
  txt: "text/plain",
};

const contentTypeOf = (filename: string) =>
  CONTENT_TYPES[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FynePDF {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  /** Files in and out. */
  readonly files: {
    upload(input: Uploadable, options?: UploadOptions): Promise<FynePDFFile>;
    fromUrl(url: string, options?: { filename?: string; ttl_seconds?: number }): Promise<FynePDFFile>;
    get(id: string): Promise<FynePDFFile>;
    list(options?: { limit?: number }): Promise<FynePDFFile[]>;
    delete(id: string): Promise<void>;
    /** The file's bytes; takes an id or a file (a job output) with its download link. */
    download(file: string | Pick<FynePDFFile, "id" | "download_url">): Promise<ArrayBuffer>;
    /** Node: downloads to a path and returns it. */
    downloadTo(file: string | Pick<FynePDFFile, "id" | "download_url">, path: string): Promise<string>;
  };

  /** Jobs: one or more steps on your files. */
  readonly jobs: {
    create(request: CreateJobRequest): Promise<Job>;
    quote(request: QuoteJobRequest): Promise<Quote>;
    get(id: string): Promise<Job>;
    list(options?: { limit?: number }): Promise<Job[]>;
    cancel(id: string): Promise<Job>;
    /** Polls until the job succeeds, fails or is canceled; throws if it fails. */
    wait(id: string | Job, options?: { timeoutMs?: number }): Promise<Job>;
  };

  /** Every PDF action as one call (a one-step job). */
  readonly pdf: PdfActions;

  /** Reading PDFs with AI. */
  readonly ai: {
    ask(request: AskPdfRequest): Promise<AskPdfResponse>;
    summarize(request: SummarizePdfRequest): Promise<SummarizePdfResponse>;
    extract(request: ExtractDataRequest): Promise<ExtractDataResponse>;
    findRedactions(request: FindRedactionsRequest): Promise<FindRedactionsResponse>;
    edit(request: EditPdfRequest): Promise<EditPdfResponse>;
  };

  /** The key you're calling with, and the credits left. */
  readonly account: {
    me(): Promise<GetMeResponse>;
    balance(): Promise<GetBalanceResponse>;
  };

  /** Every action with its parameters and price. */
  readonly actions: { list(): Promise<ListActionsResponse["data"]> };

  constructor(options: ClientOptions = {}) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const apiKey = options.apiKey ?? env?.FYNEPDF_API_KEY;
    if (!apiKey) {
      throw new Error(
        "No FynePDF API key: pass { apiKey } or set FYNEPDF_API_KEY. Make one at https://fynepdf.com/developers/dashboard.",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

    this.files = {
      upload: (input, uploadOptions) => this.upload(input, uploadOptions),
      fromUrl: (url, fileOptions) => this.request("POST", "/files", { body: { url, ...fileOptions } }),
      get: (id) => this.request("GET", `/files/${encodeURIComponent(id)}`),
      list: async (listOptions) =>
        (await this.request<{ data: FynePDFFile[] }>("GET", "/files", { query: listOptions })).data,
      delete: async (id) => {
        await this.request("DELETE", `/files/${encodeURIComponent(id)}`);
      },
      download: (file) => this.download(file),
      downloadTo: async (file, path) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, new Uint8Array(await this.download(file)));
        return path;
      },
    };

    this.jobs = {
      create: (request) => this.request("POST", "/jobs", { body: request }),
      quote: (request) => this.request("POST", "/jobs/quote", { body: request }),
      get: (id) => this.request("GET", `/jobs/${encodeURIComponent(id)}`),
      list: async (listOptions) =>
        (await this.request<{ data: Job[] }>("GET", "/jobs", { query: listOptions })).data,
      cancel: (id) => this.request("POST", `/jobs/${encodeURIComponent(id)}/cancel`),
      wait: (id, waitOptions) => this.waitForJob(typeof id === "string" ? id : id.id, waitOptions),
    };

    this.pdf = Object.fromEntries(
      Object.entries(ACTION_ROUTES).map(([name, path]) => [
        name,
        (params: Record<string, unknown>) => this.request("POST", path, { body: params }),
      ]),
    ) as unknown as PdfActions;

    this.ai = {
      ask: (request) => this.request("POST", "/ai/ask", { body: request }),
      summarize: (request) => this.request("POST", "/ai/summarize", { body: request }),
      extract: (request) => this.request("POST", "/ai/extract", { body: request }),
      findRedactions: (request) => this.request("POST", "/ai/redact-find", { body: request }),
      edit: (request) => this.request("POST", "/ai/edit", { body: request }),
    };

    this.account = {
      me: () => this.request("GET", "/me"),
      balance: () => this.request("GET", "/balance"),
    };

    this.actions = {
      list: async () => (await this.request<ListActionsResponse>("GET", "/actions")).data,
    };
  }

  /**
   * One API call. POSTs carry an Idempotency-Key, the same on every retry, so a
   * retried request never runs or charges twice. Rate limits, timeouts and
   * server errors are retried with Retry-After or a short backoff.
   */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": `fynepdf-node/${VERSION}`,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (method === "POST") headers["Idempotency-Key"] = options.idempotencyKey ?? globalThis.crypto.randomUUID();

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (attempt < this.maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new FynePDFError(0, undefined, `Couldn't reach the FynePDF API: ${reason}`);
      }
      clearTimeout(timer);
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }
      if (RETRY_STATUSES.has(response.status) && attempt < this.maxRetries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const problem = (await response.json().catch(() => undefined)) as Partial<Problem> | undefined;
      throw new FynePDFError(response.status, problem, `${method} ${path} answered ${response.status}`);
    }
  }

  private async upload(input: Uploadable, options: UploadOptions = {}): Promise<FynePDFFile> {
    let bytes: Uint8Array<ArrayBuffer>;
    let filename = options.filename;
    if (typeof input === "string") {
      const { readFile } = await import("node:fs/promises");
      const { basename } = await import("node:path");
      bytes = new Uint8Array(await readFile(input));
      filename ??= basename(input);
    } else if (input instanceof Blob) {
      bytes = new Uint8Array(await input.arrayBuffer());
      filename ??= (input as Blob & { name?: string }).name;
    } else {
      // A copy on its own ArrayBuffer, which Blob and fetch bodies require.
      bytes = new Uint8Array(input);
    }
    if (!filename) throw new Error("Give the file a name: files.upload(bytes, { filename: \"report.pdf\" }).");
    const contentType = contentTypeOf(filename);

    if (bytes.byteLength <= MULTIPART_LIMIT) {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: contentType }), filename);
      if (options.ttl_seconds) form.append("ttl_seconds", String(options.ttl_seconds));
      return this.request("POST", "/files", { form });
    }
    // Large files go straight to storage: an upload URL, a PUT, then the file.
    const created = await this.request<CreateFileResponse>("POST", "/files", {
      body: { filename, size: bytes.byteLength, content_type: contentType, ttl_seconds: options.ttl_seconds },
    });
    const put = await this.fetchImpl(created.upload_url!, {
      method: "PUT",
      headers: { "Content-Type": created.content_type ?? contentType },
      body: bytes,
    });
    if (!put.ok) throw new FynePDFError(put.status, undefined, `The upload to storage failed (${put.status}).`);
    return this.request("GET", `/files/${encodeURIComponent(created.id)}`);
  }

  /** Downloads without sending the API key to storage: the link is signed already. */
  private async download(file: string | Pick<FynePDFFile, "id" | "download_url">): Promise<ArrayBuffer> {
    let link = typeof file === "string" ? null : file.download_url;
    if (!link) {
      const id = typeof file === "string" ? file : file.id;
      const response = await this.fetchImpl(`${this.baseUrl}/files/${encodeURIComponent(id)}/content`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) link = response.headers.get("location");
      else if (response.ok) return response.arrayBuffer();
      else {
        const problem = (await response.json().catch(() => undefined)) as Partial<Problem> | undefined;
        throw new FynePDFError(response.status, problem, `Download answered ${response.status}`);
      }
    }
    const response = await this.fetchImpl(link!);
    if (!response.ok) throw new FynePDFError(response.status, undefined, `Download answered ${response.status}`);
    return response.arrayBuffer();
  }

  private async waitForJob(id: string, options: { timeoutMs?: number } = {}): Promise<Job> {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    for (;;) {
      // The API holds each poll up to 30 s, so this rarely loops more than a few times.
      const job = await this.request<Job>("GET", `/jobs/${encodeURIComponent(id)}`, { query: { wait: 30 } });
      if (job.status === "succeeded") return job;
      if (job.status === "failed" || job.status === "canceled") {
        throw new FynePDFError(200, { code: job.error?.code ?? `job_${job.status}`, detail: job.error?.message ?? `The job ${job.status}.` }, `The job ${job.status}.`);
      }
      if (Date.now() > deadline) throw new Error(`Job ${id} is still ${job.status}; call jobs.wait again or use a webhook.`);
    }
  }
}
