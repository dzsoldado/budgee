const MAX_LENGTH = 300;

// Runs of base64/base64url/hex characters this long are taken for tokens or keys. Words, file
// names (`.` splits them) and API paths stay readable.
const TOKEN_LIKE = /[A-Za-z0-9+/=_-]{24,}/g;

/**
 * An error's message for a status the user sees: token-like runs replaced by `[redacted]`, cut
 * to 300 characters. A backstop only; destinations must not put secrets in messages at all.
 */
export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : "Unknown error";
  const redacted = message.replace(TOKEN_LIKE, "[redacted]");
  return redacted.length > MAX_LENGTH ? `${redacted.slice(0, MAX_LENGTH - 1)}…` : redacted;
}
