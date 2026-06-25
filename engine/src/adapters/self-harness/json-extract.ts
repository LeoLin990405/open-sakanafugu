const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

interface ExtractedArray {
  readonly text: string;
  readonly end: number;
}

const extractFirstJsonArray = (text: string, from = 0): ExtractedArray | undefined => {
  for (let start = from; start < text.length; start += 1) {
    if (text.charAt(start) !== '[') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text.charAt(index);

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '[') {
        depth += 1;
      } else if (char === ']') {
        depth -= 1;
        if (depth === 0) return { text: text.slice(start, index + 1), end: index + 1 };
        if (depth < 0) break;
      }
    }
  }

  return undefined;
};

export const parseJsonArray = (output: string): readonly unknown[] | undefined => {
  let from = 0;
  while (from < output.length) {
    const array = extractFirstJsonArray(output, from);
    if (array === undefined) return undefined;

    try {
      const parsed: unknown = JSON.parse(array.text) as unknown;
      if (isUnknownArray(parsed)) return parsed;
    } catch {
      // Keep scanning: model prose can contain non-JSON bracketed asides before the payload.
    }
    from = array.end;
  }

  return undefined;
};
