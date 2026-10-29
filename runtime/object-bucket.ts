import { Context, Effect, Option, Stream } from "effect";
import type { ObjectStore } from "../src/object-store";
import type { StoredObject } from "../src/object-store";
import type { ObjectCatalogMetadata, ObjectWriteCondition } from "../src/protocol";
import type {
  Bucket,
  ObjectBody,
  ObjectCondition,
  ObjectInfo,
  ObjectListOptions,
  ObjectList,
} from "../src/platform";

function info(metadata: typeof ObjectCatalogMetadata.Type): ObjectInfo {
  const checksums: { sha256?: ArrayBuffer } = {};
  if (metadata.sha256 !== undefined) checksums.sha256 = new Uint8Array(metadata.sha256).buffer;
  const etag = metadata.etag;
  const quoted = { value: etag };
  if (!etag.startsWith('"')) quoted.value = JSON.stringify(etag);
  return {
    key: metadata.key,
    etag: metadata.etag,
    size: metadata.size,
    uploaded: metadata.uploaded,
    ...(metadata.customMetadata !== undefined && {
      customMetadata: { ...metadata.customMetadata },
    }),
    checksums,
    httpEtag: quoted.value,
  };
}
function allows(condition: ObjectCondition, etag: string) {
  if (
    condition.etagMatches !== undefined &&
    condition.etagMatches !== "*" &&
    condition.etagMatches !== etag
  )
    return false;
  if (condition.etagDoesNotMatch === "*" || condition.etagDoesNotMatch === etag) return false;
  return true;
}
function completedRead<A>(pending: Promise<A>, signal?: AbortSignal) {
  return pending.then(
    (value) => {
      signal?.throwIfAborted();
      return value;
    },
    (cause: unknown) => {
      signal?.throwIfAborted();
      throw cause;
    },
  );
}
function objectBody(object: StoredObject, signal?: AbortSignal): ObjectBody {
  const body = Stream.toReadableStreamWith(object.body, Context.empty(), { signal });
  const response = new Response(body);
  return {
    ...info(object.metadata),
    body,
    get bodyUsed() {
      return response.bodyUsed;
    },
    arrayBuffer: () => completedRead(response.arrayBuffer(), signal),
    text: () => completedRead(response.text(), signal),
  };
}
export class ObjectBucket implements Bucket {
  constructor(private readonly store: ReturnType<typeof ObjectStore.of>) {}

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
  async get(
    key: string,
    options: {
      readonly onlyIf?: ObjectCondition;
      readonly range?: { readonly offset: number; readonly length: number };
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ObjectBody | ObjectInfo | null> {
    options.signal?.throwIfAborted();
    if (options.onlyIf !== undefined) {
      const observed = await this.head(key, options.signal);
      if (observed === null) return null;
      if (!allows(options.onlyIf, observed.etag)) return observed;
    }
    const object = await Effect.runPromise(
      this.store.read(key, { ...(options.range !== undefined && { range: options.range }) }),
      { signal: options.signal },
    );
    if (Option.isNone(object)) {
      options.signal?.throwIfAborted();
      return null;
    }
    const result = objectBody(object.value, options.signal);
    if (options.signal?.aborted) {
      await result.body.cancel();
      options.signal.throwIfAborted();
    }
    if (options.onlyIf !== undefined && !allows(options.onlyIf, result.etag)) {
      await result.body.cancel();
      return info(object.value.metadata);
    }
    return result;
  }
  async head(key: string, signal?: AbortSignal): Promise<ObjectInfo | null> {
    signal?.throwIfAborted();
    const result = await completedRead(Effect.runPromise(this.store.head(key), { signal }), signal);
    if (Option.isNone(result)) return null;
    return info(result.value);
  }
  async put(
    key: string,
    body: string | Uint8Array,
    options: {
      readonly onlyIf?: ObjectCondition;
      readonly customMetadata?: Record<string, string>;
      readonly httpMetadata?: { readonly contentType?: string };
      readonly sha256?: Uint8Array;
    } = {},
  ) {
    const bytes = { value: new Uint8Array() };
    if (typeof body === "string") bytes.value = new TextEncoder().encode(body);
    else bytes.value = new Uint8Array(body);
    const input: typeof ObjectWriteCondition.Type = {
      ...(options.onlyIf?.etagMatches !== undefined && { ifMatch: options.onlyIf.etagMatches }),
      ...(options.onlyIf?.etagDoesNotMatch !== undefined && {
        ifNoneMatch: options.onlyIf.etagDoesNotMatch,
      }),
      ...(options.customMetadata !== undefined && { customMetadata: options.customMetadata }),
      ...(options.sha256 !== undefined && { sha256: options.sha256 }),
      ...(options.httpMetadata?.contentType !== undefined && {
        contentType: options.httpMetadata.contentType,
      }),
    };
    const result = await Effect.runPromise(this.store.write(key, bytes.value, input));
    if (Option.isNone(result)) return null;
    return result.value;
  }
  delete(key: string): Promise<void> {
    return Effect.runPromise(this.store.remove(key));
  }
  async list(options: ObjectListOptions = {}): Promise<ObjectList> {
    options.signal?.throwIfAborted();
    const page = await Effect.runPromise(
      this.store.list({
        ...(options.prefix !== undefined && { prefix: options.prefix }),
        ...(options.limit !== undefined && { limit: options.limit }),
        ...(options.delimiter !== undefined && { delimiter: options.delimiter }),
        ...(options.cursor !== undefined && { cursor: options.cursor }),
        ...(options.include !== undefined && { includeMetadata: options.include.length > 0 }),
      }),
      { signal: options.signal },
    );
    options.signal?.throwIfAborted();
    const fields = {
      objects: page.objects.map(info),
      delimitedPrefixes: [...page.delimitedPrefixes],
    };
    if (page.truncated) return { ...fields, truncated: true, cursor: page.cursor };
    return { ...fields, truncated: false };
  }
}
