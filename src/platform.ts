import type { Binding } from "./rpc";
import type * as Clock from "effect/Clock";
import type { SegmentCacheProps, TermProjectionProps, ObjectVersion } from "./protocol";

export interface BackgroundContext {
  readonly waitUntil: (work: Promise<unknown>) => void;
}
export interface ObjectCondition {
  etagMatches?: string;
  etagDoesNotMatch?: string;
}
export interface ObjectInfo {
  readonly key: string;
  readonly etag: string;
  readonly size: number;
  readonly uploaded: Date;
  readonly customMetadata?: Record<string, string>;
  readonly checksums: { readonly sha256?: ArrayBuffer };
  readonly httpEtag: string;
}
export interface ObjectBody extends ObjectInfo {
  readonly body: ReadableStream<Uint8Array>;
  readonly bodyUsed: boolean;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
  readonly text: () => Promise<string>;
}
export interface ObjectListOptions {
  signal?: AbortSignal;
  prefix?: string;
  limit?: number;
  delimiter?: string;
  cursor?: string;
  include?: ("customMetadata" | "httpMetadata")[];
}
export type ObjectList = {
  readonly objects: ObjectInfo[];
  readonly delimitedPrefixes: string[];
} & ({ readonly truncated: true; readonly cursor: string } | { readonly truncated: false });
export interface Bucket {
  get(
    key: string,
    options: { readonly onlyIf: ObjectCondition; readonly signal?: AbortSignal },
  ): Promise<ObjectBody | ObjectInfo | null>;
  get(
    key: string,
    options?: {
      readonly range?: { readonly offset: number; readonly length: number };
      readonly signal?: AbortSignal;
    },
  ): Promise<ObjectBody | null>;
  head(key: string): Promise<ObjectInfo | null>;
  put(
    key: string,
    body: string | Uint8Array,
    options?: {
      readonly onlyIf?: ObjectCondition;
      readonly customMetadata?: Record<string, string>;
      readonly httpMetadata?: { readonly contentType?: string };
      readonly sha256?: Uint8Array;
    },
  ): Promise<typeof ObjectVersion.Type | null>;
  delete(key: string): Promise<void>;
  list(options?: ObjectListOptions): Promise<ObjectList>;
}
export interface QueuePort {
  send(message: unknown): Promise<unknown>;
}
export interface JobMessage {
  readonly body: unknown;
  readonly ack: () => void;
  readonly retry: () => void;
}
export interface JobBatch {
  readonly messages: readonly JobMessage[];
}
export interface Environment {
  readonly API_TOKEN: string;
  readonly STORAGE: Bucket;
  readonly STORAGE_CACHE_SCOPE: string;
  readonly VECTOR_JOBS: QueuePort;
  readonly INDEX_JOBS: QueuePort;
}
export interface FetchService {
  fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>;
}
export interface CachePort {
  match(key: Request | URL | string): Promise<Response | undefined>;
  put(key: Request | URL | string, value: Response): Promise<void>;
  delete(key: Request | URL | string): Promise<boolean>;
}
export interface CacheProvider {
  open(name: string): Promise<CachePort>;
}
export interface SearchRuntime extends BackgroundContext {
  readonly clock?: Clock.Clock;
  readonly env: Environment;
  readonly cache: CacheProvider;
  readonly engineModule: WebAssembly.Module;
  readonly version: string;
  readonly freshRoots: boolean;
  readonly immutableIdentity: (digest: string) => string;
  readonly engineName: "rust-wasm-r2" | "rust-wasm-object-storage";
  readonly vectorName: "rust-wasm-object-storage";
  readonly equalBytes: (left: ArrayBufferView, right: ArrayBufferView) => boolean;
  readonly namespace: (name: string) => FetchService & Binding;
  readonly segments: (options: { readonly props: typeof SegmentCacheProps.Type }) => FetchService;
  readonly terms: (options: { readonly props: typeof TermProjectionProps.Encoded }) => FetchService;
}
export type EntryContext<Props> = BackgroundContext &
  (unknown extends Props ? { readonly props?: Props } : { readonly props: Props });

export class RuntimeEntry<Env, Props = unknown> {
  constructor(
    protected readonly ctx: EntryContext<Props>,
    protected readonly env: Env,
  ) {}
  async fetch(_request: Request): Promise<Response> {
    return new Response(null, { status: 404 });
  }
}
