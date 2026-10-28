export function matchCachedResponse(
  input: Request,
  bytes: Uint8Array<ArrayBuffer>,
  stored: Record<string, string>,
) {
  const headers = new Headers(stored);
  const etag = headers.get("etag");
  const condition = input.headers.get("if-none-match");
  if (
    condition !== null &&
    etag !== null &&
    condition
      .split(",")
      .some(
        (candidate) =>
          candidate.trim() === "*" ||
          candidate.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""),
      )
  )
    return new Response(null, { status: 304, headers });
  const modified = headers.get("last-modified");
  const since = input.headers.get("if-modified-since");
  if (
    condition === null &&
    modified !== null &&
    since !== null &&
    Date.parse(modified) <= Date.parse(since)
  )
    return new Response(null, { status: 304, headers });
  const range = input.headers.get("range");
  if (range === null || headers.get("content-length") !== String(bytes.byteLength))
    return new Response(bytes, { headers });
  const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (parsed === null || (parsed[1] === "" && parsed[2] === ""))
    return new Response(bytes, { headers });
  const selection = { start: Number(parsed[1]), end: bytes.byteLength - 1 };
  if (parsed[1] === "") selection.start = Math.max(0, bytes.byteLength - Number(parsed[2]));
  else if (parsed[2] !== "") selection.end = Math.min(Number(parsed[2]), selection.end);
  if (
    !Number.isSafeInteger(selection.start) ||
    !Number.isSafeInteger(selection.end) ||
    selection.start > selection.end ||
    selection.start >= bytes.byteLength ||
    (parsed[1] === "" && parsed[2] === "0")
  ) {
    headers.set("content-range", `bytes */${bytes.byteLength}`);
    headers.delete("content-length");
    return new Response(null, { status: 416, headers });
  }
  const body = bytes.slice(selection.start, selection.end + 1);
  headers.set("content-range", `bytes ${selection.start}-${selection.end}/${bytes.byteLength}`);
  headers.set("content-length", String(body.byteLength));
  return new Response(body, { status: 206, headers });
}
