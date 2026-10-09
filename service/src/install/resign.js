'use strict';

// A Tizen package carries two signatures, and from Tizen 7 the distributor certificate names the
// device it was minted for — so a package signed by whoever built it installs on their set and
// nowhere else. Given a pair minted for this TV, any package becomes installable on it.
//
// Old signatures are dropped rather than amended: every file is digested afresh, signed as the
// author, then as the distributor over the author's signature, which is the order the format wants.
//
// install/signature.js is the `tizen` CLI's own signer taking PEM instead of a PKCS#12, including
// the `%2F` in its reference URIs, which looks like a bug and is what a television accepts.

const JSZip = require('jszip');
const Signature = require('./signature.js');

const SIGNATURE_FILE = /^(author-signature\.xml|signature\d*\.xml)$/i;

// A widget names itself in config.xml and a native or .NET package in tizen-manifest.xml.
// Signing treats both the same — every file but the signatures is hashed — so the manifest
// is only ever asked for as proof the archive is a Tizen package at all.
const MANIFESTS = ['config.xml', 'tizen-manifest.xml'];

const refuse = (message) => Object.assign(new Error(message), { code: 'resignFailed' });

const isPair = (pair) => Boolean(pair) &&
    Array.isArray(pair.certificates) && pair.certificates.length &&
    pair.certificates.every((pem) => typeof pem === 'string' && /BEGIN CERTIFICATE/.test(pem)) &&
    typeof pair.key === 'string' && /BEGIN [A-Z ]*PRIVATE KEY/.test(pair.key);

const openPair = (certificates) => {
    const open = (pair, which) => {
        if (!pair) throw refuse(`No ${which} certificate is stored for this television.`);
        if (!isPair(pair)) throw refuse(`The stored ${which} certificate is not readable — send the pair again.`);
        return pair;
    };

    return {
        author: open((certificates || {}).author, 'author'),
        distributor: open((certificates || {}).distributor, 'distributor')
    };
};

// Recorded when the pair was sent: reading it back needs an ASN.1 parser, and one pair covers several sets.
const devicesOf = (certificates) => {
    const named = (certificates || {}).certDuids;

    if (Array.isArray(named)) return named.filter(Boolean);

    return (certificates || {}).certDuid ? [certificates.certDuid] : [];
};

const deviceOf = (certificates) => devicesOf(certificates)[0] || null;

// `given` is the package, or a holder with take() (pipeline.js) that hands it over without the caller
// keeping it: either way it is let go once unpacked. With `options.toFile` the signed package is written to
// that path (created new) and described by { path, size, sha256 } instead of returned as a buffer.
const resign = async (given, certificates, options = {}) => {
    // The whole package unpacked, the same ceiling pipeline.js holds its declared size to.
    const MAX_TOTAL = 256 * 1024 * 1024;

    let archive = given && typeof given.take === 'function' ? given.take() : given;

    const refuse = (message) => Object.assign(new Error(message), { code: 'resignFailed' });

    // Each file is inflated as a stream and stopped once it passes the size its archive declared for it, so a
    // package whose sizes lie (a zip bomb) costs at most what it claimed — which pipeline.js has already held
    // to a total — rather than whatever the data expands to. Where JSZip does not expose the declared size,
    // the read is as it always was.
    const readBounded = (file, name, budget) => {
        const stated = file._data && typeof file._data.uncompressedSize === 'number' ? file._data.uncompressedSize : null;

        // What this file may come to: what it declares, and never more than is left of the whole package's.
        const declared = Math.min(stated === null ? budget : stated, budget);

        if (typeof file.internalStream !== 'function') {
            return file.async('nodebuffer').then((data) => {
                if (data.length > declared) throw refuse(`${name} expands past what its package allows.`);
                return data;
            });
        }

        return new Promise((resolve, reject) => {
            const chunks = [];
            let received = 0;
            let settled = false;

            const stream = file.internalStream('nodebuffer');

            stream.on('data', (chunk) => {
                if (settled) return;
                received += chunk.length;

                if (received > declared) {
                    settled = true;
                    stream.pause();
                    reject(refuse(`${name} inflates past the ${declared} bytes its archive declares — refusing a damaged or hostile package.`));
                    return;
                }

                // JSZip hands Node buffers on Node; copied only if it ever hands something else.
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });

            stream.on('error', (error) => {
                if (settled) return;
                settled = true;
                reject(error);
            });

            stream.on('end', () => {
                if (settled) return;
                settled = true;
                resolve(Buffer.concat(chunks));
            });

            stream.resume();
        });
    };

    // The URIs are percent-encoded, so a separator becomes `%2F` and is decoded back on the way out.
    // One file at a time, so at most one is being inflated whatever the package holds.
    const contentsOf = async (zip) => {
        const named = [];
        let total = 0;

        for (const name of Object.keys(zip.files)) {
            if (zip.files[name].dir || SIGNATURE_FILE.test(name)) continue;

            const data = await readBounded(zip.files[name], name, MAX_TOTAL - total);
            total += data.length;

            named.push({ uri: encodeURIComponent(name), data });
        }

        if (!named.some((file) => MANIFESTS.indexOf(decodeURIComponent(file.uri)) !== -1)) {
            throw refuse('That package has no config.xml or tizen-manifest.xml, so it is not a Tizen package.');
        }

        return named;
    };

    const repack = async (files) => {
        const zip = files.reduce((out, file) => out.file(decodeURIComponent(file.uri), file.data), new JSZip());

        return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    };

    // Written straight to `path` as it is compressed, and hashed on the way: the signed package never exists
    // in memory whole, nor twice, which building a buffer (chunks, then the joined copy) costs.
    const repackTo = (files, path) => new Promise((resolve, reject) => {
        const { createWriteStream, mkdirSync } = require('fs');
        mkdirSync(require('path').dirname(path), { recursive: true });
        const { createHash } = require('crypto');

        const zip = files.reduce((out, file) => out.file(decodeURIComponent(file.uri), file.data), new JSZip());
        const hash = createHash('sha256');
        let size = 0;

        const out = createWriteStream(path, { flags: 'wx' });
        const source = zip.generateNodeStream({ type: 'nodebuffer', compression: 'DEFLATE', streamFiles: true });

        source.on('data', (chunk) => { hash.update(chunk); size += chunk.length; });
        source.on('error', (error) => { out.destroy(); reject(error); });
        out.on('error', reject);
        out.on('finish', () => resolve({ path, size, sha256: hash.digest('hex') }));

        source.pipe(out);
    });

    const { author, distributor } = openPair(certificates);

    let zip = await JSZip.loadAsync(archive).catch(() => {
        throw refuse('That file is not a readable package — a .wgt is a zip, and this one would not open.');
    });

    const contents = await contentsOf(zip);

    // Every file is out of it now: the package and JSZip's view of it are not needed for the signed copy.
    zip = null;
    archive = null;

    // Counted first: `Signature.sign` unshifts its own output into the array it is given.
    const digested = contents.length;

    const authored = await new Signature('AuthorSignature', contents).sign(author);
    const signed = await new Signature('DistributorSignature', authored).sign(distributor);

    if (options && options.toFile) {
        const written = await repackTo(signed, options.toFile);
        return { ...written, archive: null, device: deviceOf(certificates), files: digested };
    }

    return {
        archive: await repack(signed),
        device: deviceOf(certificates),
        files: digested
    };
};

module.exports = { resign, openPair, deviceOf, devicesOf, SIGNATURE_FILE };
