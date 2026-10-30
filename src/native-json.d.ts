interface JSON {
  rawJSON(text: string): { readonly rawJSON: string };
  isRawJSON(value: unknown): value is { readonly rawJSON: string };
}
