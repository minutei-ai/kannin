import { Schema } from "effect";
import {
  CanonicalDocument,
  CanonicalQueryDocument,
  canonicalToNativeDocument,
  nativeToCanonicalDocument,
} from "../src/protocol";
import type { Document, QueryDocument } from "../src/protocol";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Array(CanonicalDocument)));
const decodeDocument = Schema.decodeSync(Schema.fromJsonString(CanonicalDocument), {
  onExcessProperty: "error",
});
const decodeQuery = Schema.decodeSync(Schema.fromJsonString(CanonicalQueryDocument), {
  onExcessProperty: "error",
});
type FixtureDocument = typeof Document.Type & { readonly revision?: number | undefined };

export function canonicalFixtureDocuments(documents: readonly FixtureDocument[]) {
  return documents.map((document) => nativeToCanonicalDocument(document, document.revision ?? 0));
}
export function encodeCanonicalDocuments(documents: readonly FixtureDocument[]) {
  return encode(canonicalFixtureDocuments(documents));
}
export function nativeQueryFixture(
  document: typeof CanonicalQueryDocument.Type,
): typeof QueryDocument.Type {
  return { ...canonicalToNativeDocument(document), vectorSummary: document.vectorSummary };
}
export function decodeNativeQueryFixture(encoded: string) {
  return nativeQueryFixture(decodeQuery(encoded));
}

export function decodeNativeDocumentFixture(encoded: string) {
  return canonicalToNativeDocument(decodeDocument(encoded));
}
export function decodeNativeQueryFixtures(encoded: string) {
  const documents = Schema.decodeSync(Schema.fromJsonString(Schema.Array(CanonicalQueryDocument)), {
    onExcessProperty: "error",
  })(encoded);
  return documents.map(nativeQueryFixture);
}
