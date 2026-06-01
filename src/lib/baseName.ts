/** Just the file name from a full path. Handles both Unix and Windows separators. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
