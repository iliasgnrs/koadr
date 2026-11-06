import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The preview inspector runs injected from <head>, before <body> exists. It used
 * to call `document.body.classList` directly and took the entire preview down
 * with "Cannot read properties of null (reading 'classList')" on any page whose
 * <body> had attributes — because the parser had not reached it yet.
 *
 * These are source-level assertions rather than DOM tests: the script is a plain
 * public asset with no module boundary to import, and the property worth pinning
 * is that every mutation is guarded.
 */

const source = readFileSync(fileURLToPath(new URL('./inspector-script.js', import.meta.url)), 'utf8');

/*
 * Strip comments before scanning. The failure this guards against is documented in
 * the file's own comments, and matching those would turn the test into a check on
 * prose rather than on behaviour.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('preview inspector script', () => {
  it('never touches document.body or document.head unguarded', () => {
    /*
     * Allow the guarded forms only: `document.body || null` (getBody) and the
     * head fallback to documentElement.
     */
    const unguardedBody = /document\.body\.(classList|appendChild|style|innerHTML|addEventListener)/.test(code);
    const unguardedHead = /document\.head\.(appendChild|classList|innerHTML)/.test(code);

    expect(unguardedBody).toBe(false);
    expect(unguardedHead).toBe(false);
  });

  it('defers activation until the document is ready', () => {
    // The message handler must queue through whenDocumentReady, not call straight through.
    expect(code).toContain('whenDocumentReady');
    expect(code).toMatch(/whenDocumentReady\(\(\) => setInspectorActive/);
  });

  it('tolerates a missing body when activating', () => {
    expect(code).toContain('function getBody()');
    expect(code).toMatch(/const body = getBody\(\);\s*\n\s*if \(body\)/);
  });
});
