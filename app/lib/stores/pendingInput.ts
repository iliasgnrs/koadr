/*
 * A prompt queued by the zip importer and consumed by the chat input.
 *
 * This is a hand-off inside one page, so it is a module variable rather than
 * storage: it must not survive a reload or be visible to another account.
 */
let pendingZipAutorun: string | null = null;

export function setPendingZipAutorun(prompt: string) {
  pendingZipAutorun = prompt;
}

export function consumePendingZipAutorun(): string | null {
  const prompt = pendingZipAutorun;
  pendingZipAutorun = null;

  return prompt;
}
