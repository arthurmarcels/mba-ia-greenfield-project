import { parseHttpRange } from './parse-http-range.util';

describe('parseHttpRange', () => {
  const TOTAL = 2048;

  describe('no Range header', () => {
    it('returns "none" when the header is undefined', () => {
      expect(parseHttpRange(undefined, TOTAL)).toEqual({ kind: 'none' });
    });

    it('returns "none" when the header is empty or whitespace', () => {
      expect(parseHttpRange('', TOTAL)).toEqual({ kind: 'none' });
      expect(parseHttpRange('   ', TOTAL)).toEqual({ kind: 'none' });
    });
  });

  describe('explicit range bytes=<start>-<end>', () => {
    it('resolves a fully-specified range', () => {
      expect(parseHttpRange('bytes=0-1023', TOTAL)).toEqual({
        kind: 'range',
        start: 0,
        end: 1023,
      });
    });

    it('clamps end to the last byte when it exceeds the object size', () => {
      expect(parseHttpRange('bytes=1024-9999', TOTAL)).toEqual({
        kind: 'range',
        start: 1024,
        end: 2047,
      });
    });

    it('resolves a range that ends exactly at the last byte', () => {
      expect(parseHttpRange('bytes=1024-2047', TOTAL)).toEqual({
        kind: 'range',
        start: 1024,
        end: 2047,
      });
    });

    it('is invalid when start === totalSize (out of bounds)', () => {
      expect(parseHttpRange('bytes=2048-3000', TOTAL)).toEqual({
        kind: 'invalid',
      });
    });

    it('is invalid when start > end', () => {
      expect(parseHttpRange('bytes=500-100', TOTAL)).toEqual({
        kind: 'invalid',
      });
    });
  });

  describe('open-ended range bytes=<start>-', () => {
    it('extends to the end of the object', () => {
      expect(parseHttpRange('bytes=1000-', TOTAL)).toEqual({
        kind: 'range',
        start: 1000,
        end: 2047,
      });
    });

    it('is invalid when start is at or beyond the object size', () => {
      expect(parseHttpRange('bytes=2048-', TOTAL)).toEqual({
        kind: 'invalid',
      });
    });
  });

  describe('suffix range bytes=-<suffix>', () => {
    it('resolves to the last <suffix> bytes', () => {
      expect(parseHttpRange('bytes=-512', TOTAL)).toEqual({
        kind: 'range',
        start: 1536,
        end: 2047,
      });
    });

    it('returns the whole object when the suffix >= total size', () => {
      expect(parseHttpRange('bytes=-5000', TOTAL)).toEqual({
        kind: 'range',
        start: 0,
        end: 2047,
      });
    });

    it('is invalid when the suffix is not a positive integer', () => {
      expect(parseHttpRange('bytes=-0', TOTAL)).toEqual({ kind: 'invalid' });
      expect(parseHttpRange('bytes=-', TOTAL)).toEqual({ kind: 'invalid' });
    });
  });

  describe('malformed headers', () => {
    it.each([
      ['non-bytes unit', 'items=0-1023'],
      ['multiple ranges', 'bytes=0-10,20-30'],
      ['garbage', 'bytes=abc'],
      ['empty bounds', 'bytes='],
      ['negative start', 'bytes=-5-10'],
    ])('is invalid for %s', (_label, header) => {
      expect(parseHttpRange(header, TOTAL)).toEqual({ kind: 'invalid' });
    });

    it('is invalid for a zero-byte object under any range', () => {
      expect(parseHttpRange('bytes=0-0', 0)).toEqual({ kind: 'invalid' });
      expect(parseHttpRange('bytes=-1', 0)).toEqual({ kind: 'invalid' });
    });
  });
});
