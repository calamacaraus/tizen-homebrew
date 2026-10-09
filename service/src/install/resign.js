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

const resign = async (archive, certificates) => {
    const refuse = (message) => Object.assign(new Error(message), { code: 'resignFailed' });

    // Each file is inflated as a stream and stopped once it passes the size its archive declared for it, so a
    // package whose sizes lie (a zip bomb) costs at most what it claimed — which pipeline.js has already held
    // to a total — rather than whatever the data expands to. Where JSZip does not expose the declared size,
    // the read is as it always was.
    const readBounded = (file, name) => {
        const declared = file._data && typeof file._data.uncompressedSize === 'number' ? file._data.uncompressedSize : null;

        if (declared === null || typeof file.internalStream !== 'function') return file.async('nodebuffer');

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

                chunks.push(Buffer.from(chunk));
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

        for (const name of Object.keys(zip.files)) {
            if (zip.files[name].dir || SIGNATURE_FILE.test(name)) continue;

            named.push({ uri: encodeURIComponent(name), data: await readBounded(zip.files[name], name) });
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

    const { author, distributor } = openPair(certificates);

    const zip = await JSZip.loadAsync(archive).catch(() => {
        throw refuse('That file is not a readable package — a .wgt is a zip, and this one would not open.');
    });

    const contents = await contentsOf(zip);

    // Counted first: `Signature.sign` unshifts its own output into the array it is given.
    const digested = contents.length;

    const authored = await new Signature('AuthorSignature', contents).sign(author);
    const signed = await new Signature('DistributorSignature', authored).sign(distributor);

    return {
        archive: await repack(signed),
        device: deviceOf(certificates),
        files: digested
    };
};

module.exports = { resign, openPair, deviceOf, devicesOf, SIGNATURE_FILE };
