'use strict';

// Just enough of the zip format to pull one named entry out of a package, without unzipping it and
// without a library: the service bundle is held to what a television can afford to parse.
//
// Two ways to find an entry, tried in order:
//
//   1. The central directory at the end of the archive. It is the authoritative index — sizes and
//      offsets for every entry — and the only one that is right for every writer. When the reader
//      can reach the end (a whole buffer, or a file it can seek in) this is what answers.
//   2. The local headers, walked from the front. All a head-only read has. An entry written with a
//      data descriptor (general purpose bit 3) says 0 for its sizes there, because the writer did not
//      know them yet; the real ones follow the data, so the walk finds the descriptor and believes it
//      only when the size it records matches where it was found.
//
// Packages written the second way are common — Alpha, Charlie and Bravo all are — and the
// first version of this reader only walked local headers and trusted their sizes, so it read an
// empty config.xml out of them ("unexpected end of file") or walked off into the data.

const { inflateRawSync, constants } = require('zlib');

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const HAS_DESCRIPTOR = 0x0008;
const DESCRIPTOR_SIGNATURE = Buffer.from([0x50, 0x4b, 0x07, 0x08]);

const END_RECORD = 22;
const LONGEST_COMMENT = 0xffff;

// Stored and deflate are all a .wgt or .tpk uses; anything else is not something to guess at.
const STORED = 0;
const DEFLATE = 8;

// The most any one entry read here may expand to: a manifest or an icon is kilobytes.
const MAX_ENTRY = 8 * 1024 * 1024;

// Deflate cannot expand by more than about 1032 to 1, so this much compressed input can never inflate to
// more than MAX_ENTRY in one step.
const STEP = Math.floor(MAX_ENTRY / 1100);

// A manifest or an icon is never this large compressed (a 512×512 PNG does not compress below ~300KB); anything bigger is not read. Kept small because
// the step-wise inflate below re-reads its prefix, so its work grows with the square of this.
const MAX_COMPRESSED = 640 * 1024;

// A source is anything with a size and a way to read a range: a Buffer, or an open file on a USB
// stick that should not be pulled into memory whole to read 2KB of XML from it.
const fromBuffer = (buffer) => ({
    size: buffer.length,
    read: (offset, length) => buffer.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, length))
});

const fromFile = (handle, size, readSync) => ({
    size,
    read: (offset, length) => {
        const start = Math.max(0, offset);
        const wanted = Math.max(0, Math.min(length, size - start));
        const out = Buffer.alloc(wanted);
        const got = wanted ? readSync(handle, out, 0, wanted, start) : 0;
        return out.slice(0, got);
    }
});

// Bounded without trusting anything the archive declares: the television's runtime (lwnode, Node 12.16)
// predates inflate's maxOutputLength, and a declared size is only a claim. So the data is inflated a step
// at a time — each prefix with a sync flush, which yields what that much input decodes to — and abandoned
// as soon as the output passes the cap. No step can add more than MAX_ENTRY, so memory stays near twice
// the cap however the entry was built; the price is re-reading the prefix, which for the kilobytes a
// manifest or icon takes is nothing.
// `expected` is the size the archive declares: passing it is reason to stop early, since an entry that
// inflates past its own declaration is refused afterwards anyway.
const boundedInflate = (data, expected = null) => {
    if (data.length > MAX_COMPRESSED) return null;

    const limit = typeof expected === 'number' && expected > 0 ? Math.min(expected, MAX_ENTRY) : MAX_ENTRY;

    for (let end = Math.min(STEP, data.length); ; end = Math.min(end + STEP, data.length)) {
        const whole = end === data.length;
        const out = inflateRawSync(data.slice(0, end), whole ? {} : { finishFlush: constants.Z_SYNC_FLUSH });

        if (out.length > limit) return null;
        if (whole) return out;
    }
};

const inflate = (compression, data, expected) => {
    if (typeof expected === 'number' && expected > MAX_ENTRY) return null;
    if (compression === STORED) return data.length > MAX_ENTRY ? null : data;
    if (compression !== DEFLATE) return null;

    const out = boundedInflate(data, expected);
    if (!out) return null;

    // A size the archive declared and the data disagree with is a damaged package, not a short read.
    if (typeof expected === 'number' && expected > 0 && out.length !== expected) return null;

    return out;
};

// The end record sits in the last 22 bytes, or up to 64KB earlier when the archive has a comment.
const findEnd = (source) => {
    if (source.size < END_RECORD) return null;

    const span = Math.min(source.size, END_RECORD + LONGEST_COMMENT);
    const tail = source.read(source.size - span, span);

    for (let at = tail.length - END_RECORD; at >= 0; at -= 1) {
        if (tail.readUInt32LE(at) !== END_OF_CENTRAL) continue;

        const entries = tail.readUInt16LE(at + 10);
        const directorySize = tail.readUInt32LE(at + 12);
        const directoryAt = tail.readUInt32LE(at + 16);

        // ZIP64 (0xffff/0xffffffff here) is for archives far past anything a television installs.
        if (directoryAt === 0xffffffff || entries === 0xffff) return null;
        if (directoryAt + directorySize > source.size) return null;

        return { entries, directorySize, directoryAt };
    }

    return null;
};

// Every entry the central directory names, in its order. Null when there is no directory to read,
// which is the head-only case and not an error.
const centralEntries = (source) => {
    const end = findEnd(source);
    if (!end) return null;

    const directory = source.read(end.directoryAt, end.directorySize);
    const found = [];

    let cursor = 0;

    for (let index = 0; index < end.entries; index += 1) {
        if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_HEADER) return null;

        const nameLength = directory.readUInt16LE(cursor + 28);
        const extraLength = directory.readUInt16LE(cursor + 30);
        const commentLength = directory.readUInt16LE(cursor + 32);

        found.push({
            name: directory.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
            compression: directory.readUInt16LE(cursor + 10),
            compressedSize: directory.readUInt32LE(cursor + 20),
            size: directory.readUInt32LE(cursor + 24),
            localAt: directory.readUInt32LE(cursor + 42)
        });

        cursor += 46 + nameLength + extraLength + commentLength;
    }

    return found;
};

const fromCentral = (source, entry) => {
    const header = source.read(entry.localAt, 30);
    if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_HEADER) return null;

    // The local copy's own name and extra lengths place the data; they may differ from the directory's.
    const dataAt = entry.localAt + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = source.read(dataAt, entry.compressedSize);

    if (data.length < entry.compressedSize) return null;

    return inflate(entry.compression, data, entry.size);
};

// The descriptor after a descriptor-style entry, believed only when the compressed size it records is
// the distance from the data to where it was found — a stray PK\7\8 inside compressed data will not
// also carry that number.
const descriptorAfter = (head, dataAt) => {
    for (let at = head.indexOf(DESCRIPTOR_SIGNATURE, dataAt); at !== -1;
        at = head.indexOf(DESCRIPTOR_SIGNATURE, at + 1)) {
        if (at + 16 > head.length) return null;
        if (head.readUInt32LE(at + 8) === at - dataAt) {
            return { compressedSize: at - dataAt, size: head.readUInt32LE(at + 12), length: 16 };
        }
    }

    return null;
};

const fromLocalHeaders = (head, wanted) => {
    let cursor = 0;

    while (cursor + 30 <= head.length) {
        if (head.readUInt32LE(cursor) !== LOCAL_HEADER) return null;

        const flags = head.readUInt16LE(cursor + 6);
        const compression = head.readUInt16LE(cursor + 8);
        const nameLength = head.readUInt16LE(cursor + 26);
        const extraLength = head.readUInt16LE(cursor + 28);

        const nameAt = cursor + 30;
        const name = head.slice(nameAt, nameAt + nameLength).toString('utf8');
        const dataAt = nameAt + nameLength + extraLength;

        let compressedSize = head.readUInt32LE(cursor + 18);
        let size = head.readUInt32LE(cursor + 22);
        let trailer = 0;

        if (flags & HAS_DESCRIPTOR) {
            const descriptor = descriptorAfter(head, dataAt);
            if (!descriptor) return null;

            compressedSize = descriptor.compressedSize;
            size = descriptor.size;
            trailer = descriptor.length;
        }

        if (name === wanted) {
            const data = head.slice(dataAt, dataAt + compressedSize);
            if (data.length < compressedSize) return null;

            return inflate(compression, data, size);
        }

        cursor = dataAt + compressedSize + trailer;
    }

    return null;
};

// One entry's contents, or null when the archive does not have it (or this much of it does not).
// Throws only on data that claims to be deflate and is not — a damaged package, said as such.
const read = (source, wanted) => {
    const listed = centralEntries(source);

    if (listed) {
        const entry = listed.find((candidate) => candidate.name === wanted);
        return entry ? fromCentral(source, entry) : null;
    }

    return fromLocalHeaders(source.read(0, source.size), wanted);
};

// What the archive says it expands to in all, from its directory; null when there is none to ask.
const expandedSize = (source) => {
    const listed = centralEntries(source);
    return listed ? listed.reduce((total, entry) => total + entry.size, 0) : null;
};

const names = (source) => {
    const listed = centralEntries(source);
    return listed ? listed.map((entry) => entry.name) : null;
};

// Every entry inflated as a stream and its output counted, nothing kept: a package whose data expands past
// what its directory declares — per entry, or past `budget` in all — is found before anything that
// inflates it whole (JSZip, when a custom icon is written in) gets to try. Resolves to the true total.
const verifySizes = async (source, budget) => {
    const { createInflateRaw } = require('zlib');
    const listed = centralEntries(source);

    if (!listed) throw Object.assign(new Error('The package has no readable directory of its files.'), { code: 'badPackage' });

    let total = 0;

    for (const entry of listed) {
        const header = source.read(entry.localAt, 30);
        if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_HEADER) {
            throw Object.assign(new Error(`${entry.name} is not where the package says it is.`), { code: 'badPackage' });
        }

        const dataAt = entry.localAt + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        const limit = Math.min(entry.size, budget - total);

        const produced = entry.compression === STORED ? entry.compressedSize : await new Promise((resolve, reject) => {
            if (entry.compression !== DEFLATE) return reject(Object.assign(new Error(`${entry.name} uses a compression a package does not.`), { code: 'badPackage' }));

            const inflater = createInflateRaw();
            let out = 0;
            let done = false;

            const finish = (error, value) => {
                if (done) return;
                done = true;
                if (error) {
                    inflater.destroy();
                    reject(error);
                } else {
                    resolve(value);
                }
            };

            inflater.on('data', (chunk) => {
                out += chunk.length;
                if (out > limit) {
                    finish(Object.assign(new Error(`${entry.name} expands past the ${entry.size} bytes its package declares — ` +
                        'a damaged or hostile package.'), { code: 'tooLarge' }));
                }
            });
            inflater.on('error', (error) => finish(Object.assign(error, { code: 'badPackage' })));
            inflater.on('end', () => finish(null, out));

            // Fed in pieces, so a large entry is never read off a file whole.
            const PIECE = 256 * 1024;
            const feed = (from) => {
                let offset = from;

                while (!done && offset < entry.compressedSize) {
                    const piece = source.read(dataAt + offset, Math.min(PIECE, entry.compressedSize - offset));
                    if (!piece.length) break;

                    offset += piece.length;

                    // Full: carried on once the inflater has drained, so its output is counted as it goes.
                    if (!inflater.write(piece)) return inflater.once('drain', () => feed(offset));
                }

                if (!done) inflater.end();
                return undefined;
            };

            feed(0);
        });

        if (produced > limit) throw Object.assign(new Error(`${entry.name} is larger than its package declares.`), { code: 'tooLarge' });

        total += produced;
    }

    return total;
};

module.exports = { verifySizes, read, names, expandedSize, fromBuffer, fromFile, centralEntries, boundedInflate, LOCAL_HEADER, MAX_ENTRY };
