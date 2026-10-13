export function corpus(offset: number, size: number) {
  return Array.from({ length: Math.min(500, size - offset) }, (_, ordinal) => {
    const id = offset + ordinal;
    return {
      id: String(id),
      text: `cloudflare rust search group${id % 100} unique${id} ${"storage latency durable object ".repeat(8 + (id % 8))}`,
      attributes: { group: id % 100, year: 2020 + (id % 7) },
    };
  });
}
