import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_TEXT_BYTES, isImageAttachment, isTextAttachment } from './fileUtils';

const fileOf = (name: string, type = '') => new File(['content'], name, { type });

describe('attachment classification', () => {
  it('treats raster images as images', () => {
    expect(isImageAttachment(fileOf('shot.png', 'image/png'))).toBe(true);
    expect(isImageAttachment(fileOf('shot.jpg', 'image/jpeg'))).toBe(true);
  });

  it('inlines copilot-instructions.md as text', () => {
    expect(isImageAttachment(fileOf('copilot-instructions.md', 'text/markdown'))).toBe(false);
    expect(isTextAttachment(fileOf('copilot-instructions.md', 'text/markdown'))).toBe(true);
  });

  it('classifies by extension when the browser reports no media type', () => {
    expect(isTextAttachment(fileOf('AGENTS.md'))).toBe(true);
    expect(isTextAttachment(fileOf('notes.md'))).toBe(true);
    expect(isTextAttachment(fileOf('schema.sql'))).toBe(true);
    expect(isTextAttachment(fileOf('archive.bin'))).toBe(false);
  });

  it('refuses svg as an image so it is inlined as text instead', () => {
    expect(isImageAttachment(fileOf('logo.svg', 'image/svg+xml'))).toBe(false);
    expect(isTextAttachment(fileOf('logo.svg', 'image/svg+xml'))).toBe(true);
  });

  it('exposes a text size ceiling that fits in a 1MB text part', () => {
    expect(MAX_ATTACHMENT_TEXT_BYTES).toBeLessThan(1024 * 1024);
  });
});
