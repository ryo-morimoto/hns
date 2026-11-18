/**
 * A zip built in a test, so a prescan scenario has a real archive to read.
 *
 * @remarks
 * Stored entries only ("method 0"): a fixture that only claims a size needs no deflate stream, and
 * the declared sizes can be set apart from the bytes on disk, which is what a decompression bomb
 * does. The central directory is real, because that is what the prescan trusts.
 */

/** One entry of a fixture archive. */
interface FixtureEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Write a 16-bit little-endian value. */
function write16(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
}

/** Write a 32-bit little-endian value. */
function write32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
  bytes[at + 2] = (value >>> 16) & 0xff;
  bytes[at + 3] = (value >>> 24) & 0xff;
}

/**
 * The CRC-32 of a run of one byte, for as many bytes as an entry claims.
 *
 * @param byte - The byte the run is made of.
 * @param length - How many bytes.
 * @returns The IEEE 802.3 checksum, from a 256-entry table built once.
 */
function crc32Of(byte: number, length: number): number {
  let crc = 0xffffffff;
  for (let index = 0; index < length; index += 1) {
    crc = ((crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The CRC-32 lookup table, one entry per byte; built once. */
const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table.push(value >>> 0);
  }
  return table;
})();

/**
 * Build a stored zip.
 *
 * @param files - The names and their text, one entry each.
 * @param claims - Uncompressed sizes to declare instead of the text's, per name.
 * @returns The archive's bytes.
 *
 * @remarks
 * A claim larger than the entry's text is what a decompression bomb's central directory says: the
 * reader trusts it until it has inflated the stream, which the prescan never gets to do. The
 * checksum is the claim's run's, so an archive a zip tool reads agrees with itself.
 */
export function zipOf(
  files: ReadonlyMap<string, string>,
  claims: { readonly declaredBytes?: ReadonlyMap<string, number> } = {},
): Uint8Array {
  const entries: FixtureEntry[] = [];
  for (const [name, text] of files) entries.push({ name, bytes: new TextEncoder().encode(text) });
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const declared = claims.declaredBytes?.get(entry.name) ?? entry.bytes.byteLength;
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32Of(entry.bytes[0] ?? 0, declared);
    const local = new Uint8Array(30 + nameBytes.length + entry.bytes.length);
    local.set([0x50, 0x4b, 0x03, 0x04], 0);
    write16(local, 4, 20);
    write16(local, 8, 0);
    write16(local, 12, 0x21);
    write32(local, 14, crc);
    write32(local, 18, entry.bytes.length);
    write32(local, 22, declared);
    write16(local, 26, nameBytes.length);
    local.set(nameBytes, 30);
    local.set(entry.bytes, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    central.set([0x50, 0x4b, 0x01, 0x02], 0);
    write16(central, 4, 20);
    write16(central, 6, 20);
    write16(central, 8, 0);
    write16(central, 10, 0);
    write16(central, 12, 0x21);
    write16(central, 14, 0);
    write32(central, 16, crc);
    write32(central, 20, entry.bytes.length);
    write32(central, 24, declared);
    write16(central, 28, nameBytes.length);
    write16(central, 30, 0);
    write16(central, 32, 0);
    write16(central, 34, 0);
    write16(central, 36, 0);
    write32(central, 38, 0);
    write32(central, 42, offset);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = centrals.reduce((total, central) => total + central.length, 0);
  const end = new Uint8Array(22);
  end.set([0x50, 0x4b, 0x05, 0x06], 0);
  write16(end, 8, files.size);
  write16(end, 10, files.size);
  write32(end, 12, directory);
  write32(end, 16, offset);
  const zip = new Uint8Array(offset + directory + end.length);
  let at = 0;
  for (const part of new Array<Uint8Array>().concat(locals, centrals, [end])) {
    zip.set(part, at);
    at += part.length;
  }
  return zip;
}

/**
 * Build a zip64 archive with a given number of tiny entries.
 *
 * @param count - How many entries the archive holds.
 * @returns The archive's bytes, with a zip64 end record and locator.
 *
 * @remarks
 * An archive with more than 65,535 entries is written zip64, so this is what a zip bomb with many
 * parts actually looks like on disk: the 16-bit fields in the classic end record are saturated and
 * the count is in the zip64 record. Every entry is one stored byte with the name `o`.
 */
export function buildZip64(count: number): Uint8Array {
  const name = new TextEncoder().encode("o");
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const crc = crc32Of(0x78, 1);
    const local = new Uint8Array(30 + name.length + 1);
    local.set([0x50, 0x4b, 0x03, 0x04], 0);
    write16(local, 4, 20);
    write16(local, 8, 0);
    write16(local, 12, 0x21);
    write32(local, 14, crc);
    write32(local, 18, 1);
    write32(local, 22, 1);
    write16(local, 26, name.length);
    local.set(name, 30);
    local[30 + name.length] = 0x78;
    const central = new Uint8Array(46 + name.length);
    central.set([0x50, 0x4b, 0x01, 0x02], 0);
    write16(central, 4, 20);
    write16(central, 6, 20);
    write16(central, 12, 0x21);
    write32(central, 16, crc);
    write32(central, 20, 1);
    write32(central, 24, 1);
    write16(central, 28, name.length);
    write32(central, 42, offset);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = centrals.reduce((total, central) => total + central.length, 0);
  // The zip64 end-of-central-directory record, its locator, and the classic end record with the
  // fields saturated, in that order, as a writer emits them.
  const zip64 = new Uint8Array(56);
  zip64.set([0x50, 0x4b, 0x06, 0x06], 0);
  write64(zip64, 8, 0n);
  write64(zip64, 16, 0n);
  write64(zip64, 24, BigInt(count));
  write64(zip64, 32, BigInt(count));
  write64(zip64, 40, BigInt(directory));
  write64(zip64, 48, BigInt(offset));
  const locator = new Uint8Array(20);
  locator.set([0x50, 0x4b, 0x06, 0x07], 0);
  write32(locator, 4, 0);
  write64(locator, 8, BigInt(offset + directory));
  write32(locator, 16, 1);
  const end = new Uint8Array(22);
  end.set([0x50, 0x4b, 0x05, 0x06], 0);
  write16(end, 8, 0xffff);
  write16(end, 10, 0xffff);
  write32(end, 12, 0xffffffff);
  write32(end, 16, 0xffffffff);
  const zip = new Uint8Array(offset + directory + zip64.length + locator.length + end.length);
  let at = 0;
  for (const part of new Array<Uint8Array>().concat(locals, centrals, [zip64, locator, end])) {
    zip.set(part, at);
    at += part.length;
  }
  return zip;
}

/** Write a 64-bit little-endian value. */
function write64(bytes: Uint8Array, at: number, value: bigint): void {
  write32(bytes, at, Number(value & 0xffffffffn));
  write32(bytes, at + 4, Number((value >> 32n) & 0xffffffffn));
}
