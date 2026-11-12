/** Replace known secrets so a tool error cannot echo an API key. */
export function redact(message: string, secrets: readonly (string | undefined)[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out;
}
