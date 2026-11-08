import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ByteReader, F3dFormatError } from './byteReader';
import { readDesignStreams, readPackage } from './f3dArchive';

const design = (prefix: string, meta: string, bulk: string) => ({
  [`${prefix}/Design1/MetaStream.dat`]: strToU8(meta),
  [`${prefix}/Design1/BulkStream.dat`]: strToU8(bulk),
});

describe('readPackage', () => {
  const member = (text: string) => zipSync(design('FusionAssetName[Active]', text, 'bulk'));
  const description = {
    designDescription: {
      designGraphs: [
        {
          rootIds: [1],
          designObjects: [
            {
              id: 1,
              relativePath: 'root.f3d',
              friendlyName: 'Printer',
              references: [{ relationships: [{ id: 2, metadata: { neutronRole: 'AB-CD' } }] }],
            },
            { id: 2, relativePath: 'bolt.f3d', friendlyName: 'Bolt' },
          ],
        },
      ],
    },
  };

  it('finds the root and what each of its links opens', () => {
    const file = zipSync({
      'bolt.f3d': member('bolt'),
      'root.f3d': member('root'),
      'DesignDescription.json': strToU8(JSON.stringify(description)),
    });
    const pack = readPackage(file);
    expect(pack.root).toBe('root.f3d');
    expect(pack.roles('root.f3d').get('ab-cd')).toBe('bolt.f3d');
    expect(pack.nameOf('bolt.f3d')).toBe('Bolt');
    expect(new TextDecoder().decode(pack.open('bolt.f3d').meta)).toBe('bolt');
  });

  it('falls back to the manifest when the description is unreadable', () => {
    const file = zipSync({
      'a.f3d': member('a'),
      'b.f3d': member('b'),
      'Manifest.json': strToU8('{"root":"b.f3d"}'),
      'DesignDescription.json': strToU8('{'),
    });
    expect(readPackage(file).root).toBe('b.f3d');
  });

  it('refuses a member the package does not hold', () => {
    const pack = readPackage(zipSync({ 'a.f3d': member('a') }));
    expect(() => pack.open('b.f3d')).toThrow(F3dFormatError);
  });

  it('treats a lone design as a package with no links', () => {
    const pack = readPackage(zipSync(design('FusionAssetName[Active]', 'm', 'b')));
    expect(pack.root).toBe('');
    expect(pack.roles('').size).toBe(0);
  });
});

describe('readDesignStreams', () => {
  it('finds the design streams, stored or deflated', () => {
    const file = zipSync(design('FusionAssetName[Active]', 'meta', 'bulk'), { level: 6 });
    const streams = readDesignStreams(file);
    expect(new TextDecoder().decode(streams.meta)).toBe('meta');
    expect(new TextDecoder().decode(streams.bulk)).toBe('bulk');
  });

  it('reads the newer segment folder name', () => {
    const file = zipSync({
      'A[Active]/FusionDesignSegmentType1/MetaStream.dat': strToU8('m'),
      'A[Active]/FusionDesignSegmentType1/BulkStream.dat': strToU8('b'),
    });
    expect(new TextDecoder().decode(readDesignStreams(file).bulk)).toBe('b');
  });

  it('prefers the active asset over another state', () => {
    const file = zipSync({ ...design('Old', 'old', 'old'), ...design('Now[Active]', 'now', 'now') });
    expect(new TextDecoder().decode(readDesignStreams(file).meta)).toBe('now');
  });

  it('opens the root of a package', () => {
    const member = (text: string) => zipSync(design('A[Active]', text, text));
    const file = zipSync(
      {
        'other.f3d': member('other'),
        'root.f3d': member('root'),
        'Manifest.json': strToU8(JSON.stringify({ root: 'root.f3d' })),
      },
      { level: 0 },
    );
    expect(new TextDecoder().decode(readDesignStreams(file).meta)).toBe('root');
  });

  it('says so when a file has no design', () => {
    expect(() => readDesignStreams(zipSync({ 'notes.txt': strToU8('hello') }))).toThrow(F3dFormatError);
  });

  it('refuses bytes that are not an archive', () => {
    expect(() => readDesignStreams(strToU8('not a zip at all, just some text'))).toThrow(F3dFormatError);
  });

  it('refuses an entry declaring more than the limit before inflating it', () => {
    const file = zipSync(design('A[Active]', 'meta', 'bulk'));
    // Rewrite the first central directory entry's uncompressed size to 4 GiB - 2.
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    for (let i = file.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 0xfffffffe, true);
    }
    expect(() => readDesignStreams(file)).toThrow(/too large/);
  });
});

describe('ByteReader', () => {
  it('refuses a read past the end', () => {
    expect(() => new ByteReader(Uint8Array.from([1, 2])).u32()).toThrow(F3dFormatError);
  });

  it('refuses a string longer than the range', () => {
    const r = new ByteReader(Uint8Array.from([255, 255, 255, 127, 0]));
    expect(() => r.str8()).toThrow(F3dFormatError);
  });

  it('refuses a count larger than the bytes left', () => {
    const r = new ByteReader(Uint8Array.from([100, 0, 0, 0, 1, 2]));
    expect(() => r.count(8)).toThrow(F3dFormatError);
  });
});
