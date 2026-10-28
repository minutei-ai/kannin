export async function sha256(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
}

export async function sha256Bytes(bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toHex();
}
