import { formatIssuePath } from '@olan-app/schema';

export interface JsonPosition {
  line: number;
  column: number;
}

/**
 * Maps every value in a JSON document to its 1-based line and column, keyed by the path format
 * `@olan-app/schema` uses in issues (`permissions[1]`, `surfaces["project.widget"].title`, `''`
 * for the root). For an object member the position is that of its key, which is where an editor
 * should jump. Returns an empty map for text that is not valid JSON.
 */
export function locateJson(text: string): Map<string, JsonPosition> {
  const positions = new Map<string, JsonPosition>();
  let index = 0;
  let line = 1;
  let column = 1;

  const advance = (count = 1) => {
    for (let n = 0; n < count && index < text.length; n++) {
      if (text[index] === '\n') {
        line++;
        column = 1;
      } else {
        column++;
      }
      index++;
    }
  };
  const skipWhitespace = () => {
    while (index < text.length && /\s/.test(text[index]!)) advance();
  };
  const here = (): JsonPosition => ({ line, column });

  const parseString = (): string => {
    const start = index;
    advance(); // opening quote
    while (index < text.length && text[index] !== '"') advance(text[index] === '\\' ? 2 : 1);
    advance(); // closing quote
    return JSON.parse(text.slice(start, index)) as string;
  };

  const parseValue = (path: PropertyKey[], position: JsonPosition | null) => {
    skipWhitespace();
    const key = formatIssuePath(path);
    if (!positions.has(key)) positions.set(key, position ?? here());
    const char = text[index];
    if (char === '{') {
      advance();
      skipWhitespace();
      if (text[index] === '}') return advance();
      for (;;) {
        skipWhitespace();
        const keyPosition = here();
        const name = parseString();
        skipWhitespace();
        advance(); // colon
        parseValue([...path, name], keyPosition);
        skipWhitespace();
        if (text[index] === ',') {
          advance();
          continue;
        }
        advance(); // closing brace
        return;
      }
    }
    if (char === '[') {
      advance();
      skipWhitespace();
      if (text[index] === ']') return advance();
      for (let item = 0; ; item++) {
        skipWhitespace();
        parseValue([...path, item], null);
        skipWhitespace();
        if (text[index] === ',') {
          advance();
          continue;
        }
        advance();
        return;
      }
    }
    if (char === '"') {
      parseString();
      return;
    }
    while (index < text.length && !/[\s,\]}]/.test(text[index]!)) advance();
  };

  try {
    JSON.parse(text);
  } catch {
    return positions;
  }
  try {
    parseValue([], null);
  } catch {
    // Positions found so far stay useful.
  }
  return positions;
}

/**
 * The position for an issue path, falling back to the closest ancestor that exists (a missing
 * field is reported at its parent object).
 */
export function positionFor(positions: Map<string, JsonPosition>, path: string): JsonPosition | undefined {
  let current = path;
  for (;;) {
    const found = positions.get(current);
    if (found) return found;
    if (!current) return undefined;
    const cut = Math.max(current.lastIndexOf('.'), current.lastIndexOf('['));
    current = cut <= 0 ? '' : current.slice(0, cut);
  }
}

/** 1-based line and column of a character offset. */
export function offsetToPosition(text: string, offset: number): JsonPosition {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
