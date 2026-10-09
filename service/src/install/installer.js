'use strict';

const { mkdirSync, readdirSync, unlinkSync, statSync, createReadStream, promises } = require('fs');
const { createHash, randomBytes } = require('crypto');

const { interpret, settled } = require('./verdicts.js');

const STAGING_DIR = '/home/owner/share/tmp/sdk_tools';
const INSTALL_TIMEOUT = 180000;

const problem = (code, message) => Object.assign(new Error(message), { code });

// Running on the TV makes staging an ordinary file write, with no ADB sync protocol to reimplement.
// Each install gets a name of its own, so nothing can be put in its place ahead of time, and what is on disk
// is read back and hashed before it is installed: the bytes installed are the bytes that were signed.
const OURS = /^homebrew-[0-9a-f]{16}\.(wgt|tpk)$/;

// Hashed 4MB at a time with a turn of the event loop between, so a large package does not stop the service
// answering the phone while it is checked.
const digest = async (buffer) => {
    const hash = createHash('sha256');
    const PIECE = 4 * 1024 * 1024;

    for (let at = 0; at < buffer.length; at += PIECE) {
        hash.update(buffer.slice(at, at + PIECE));
        if (at + PIECE < buffer.length) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return hash.digest('hex');
};

// Read back in pieces, so checking a large package does not hold a second copy of it in memory, and
// asynchronously, so the service keeps answering while a large one is checked.
const digestOfFile = (path) => new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path, { highWaterMark: 256 * 1024 });

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
});

// A staging path of its own, for the signer to write into directly.
// Only a name: the signer creates the directory and the file when it writes.
const reserve = ({ isWgt }, dir = STAGING_DIR) => `${dir}/homebrew-${randomBytes(8).toString('hex')}.${isWgt ? 'wgt' : 'tpk'}`;

// What the signer wrote, read back off the flash and held to the hash it computed as it wrote.
const verifyStaged = async (path, sha256) => {
    if (await digestOfFile(path) !== sha256) {
        unstage(path);
        throw problem('internal', 'The staged package does not match what was signed; it was removed and not installed.');
    }
    return path;
};

const stage = async (archive, { isWgt }, dir = STAGING_DIR) => {
    const path = `${dir}/homebrew-${randomBytes(8).toString('hex')}.${isWgt ? 'wgt' : 'tpk'}`;
    const expected = await digest(archive);

    mkdirSync(dir, { recursive: true });

    // Created new, never written through an existing file. Readable as any staged package is: the TV's own
    // installer reads it, possibly as another user, and a signed package holds nothing secret.
    await promises.writeFile(path, archive, { flag: 'wx' });

    if (await digestOfFile(path) !== expected) {
        unstage(path);
        throw problem('internal', 'The staged package does not match what was signed; it was removed and not installed.');
    }

    return path;
};

// After every install, whatever its outcome: the package is in the TV's own store by then, or refused.
const unstage = (path) => {
    if (!path) return false;

    try {
        unlinkSync(path);
        return true;
    } catch (e) {
        // Never written (the signer failed before it began) is as removed as can be.
        return e.code === 'ENOENT';
    }
};

// What an install interrupted by a restart left behind, and the single package.wgt earlier versions of this
// service kept after every install. The laptop's tools stage a package.wgt into the same directory too, so
// that one is left alone unless it is old enough that no install can still be reading it.
const LEFT_BEHIND = 10 * 60 * 1000;

const stale = (path) => {
    try {
        return Date.now() - statSync(path).mtime.getTime() > LEFT_BEHIND;
    } catch (e) {
        return false;
    }
};

// `everything` at startup, when no install can be running; between installs only what is old enough.
const sweep = (dir = STAGING_DIR, { everything = true } = {}) => {
    let names = [];

    try {
        names = readdirSync(dir);
    } catch (e) {
        return 0;
    }

    return names.filter((name) => (OURS.test(name) && (everything || stale(`${dir}/${name}`))) ||
            ((name === 'package.wgt' || name === 'package.tpk') && stale(`${dir}/${name}`)))
        .filter((name) => unstage(`${dir}/${name}`)).length;
};

const run = (session, path, packageId) =>
    session.exec(`shell:0 vd_appinstall ${packageId} ${path}`, {
        timeout: INSTALL_TIMEOUT,
        until: settled
    }).then((output) => interpret(output, { packageId }));

module.exports = { reserve, verifyStaged, digest, stage, unstage, sweep, run, digestOfFile, STAGING_DIR, LEFT_BEHIND };
