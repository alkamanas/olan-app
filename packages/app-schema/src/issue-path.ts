/** Formats a zod issue path: `permissions[1]`, `surfaces["project.widget"].title`; empty for the root. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (typeof segment === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) out += out ? `.${segment}` : segment;
    else out += `[${JSON.stringify(String(segment))}]`;
  }
  return out;
}
