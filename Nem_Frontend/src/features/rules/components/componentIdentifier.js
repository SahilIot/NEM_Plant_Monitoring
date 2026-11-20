// Mirrors the server rules (services/component_identifier.py); the server stays the authority.
export const MAX_COMPONENT_IDENTIFIER = 100;
const ALLOWED = /^[\p{L}\p{N}_ .,:;#/\\()+&'-]+$/u;

/** Trimmed, whitespace-collapsed identifier; blank means "none" (null). */
export function normalizeComponentIdentifier(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

/** A message when the identifier would be rejected, otherwise "". */
export function componentIdentifierProblem(value) {
  const text = normalizeComponentIdentifier(value);
  if (text === null) return "";
  if (text.length > MAX_COMPONENT_IDENTIFIER) return `The identifier can be at most ${MAX_COMPONENT_IDENTIFIER} characters.`;
  if (!ALLOWED.test(text)) return "The identifier can contain letters, numbers, spaces and . , : ; # / \\ ( ) + & ' - _ only.";
  return "";
}
