/** File-name validation shared with the renderer (no Node imports). */
export function validateFileName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Type a file name";
  if (n === "." || n === "..") return "That name is reserved";
  if (n.includes("/")) return "File names cannot contain “/”";
  if (n.includes("\0")) return "Invalid file name";
  if (new TextEncoder().encode(n).length > 255) return "That name is too long";
  return null;
}
