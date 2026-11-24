// Dev builds only: Settings → Developer hands a setup secret to the Connect form, in memory.
let secret = "";

export function setDevSetupSecret(value: string): void {
  secret = value;
}

/** The secret handed over, once. */
export function takeDevSetupSecret(): string {
  const value = secret;
  secret = "";
  return value;
}
