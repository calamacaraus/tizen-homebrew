'use strict';

// The icon of every app on the television, for the phone's list. Kept as small files beside the
// configuration, one per package, and served by package id — so the list itself stays small and the
// phone's browser caches each picture.
//
// Two ways one is learned:
//   - at install, from the package this service just signed: it holds the icon (your own, when you set one);
//   - for an app installed some other way, from the file the television names for it, when another app's
//     file is readable at all. Where it is not, the phone shows the app's letter, as before.
//
// Only PNG and JPEG, 512KB each (a 512×512 PNG is often 300KB), 12MB in all, and only for what is installed:
// an app that is gone takes its icon with it.

const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, realpathSync, unlinkSync } = require('fs');
const { join } = require('path');

const zip = require('./zip.js');

const MAX_ICON = 512 * 1024;
const MAX_TOTAL = 12 * 1024 * 1024;
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.(png|jpg)$/;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const kindOf = (bytes) => {
    if (!bytes || bytes.length < 8 || bytes.length > MAX_ICON) return null;
    if (bytes.slice(0, 8).equals(PNG)) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    return null;
};

const { createHmac } = require('crypto');

// `key` makes each icon's address unguessable: without it, any page could find out which apps are
// installed by trying package ids as image addresses. Paired phones are handed the addresses.
const createAppIcons = ({ dir, log, key = null }) => {
    const tokenOf = (file) => (key ? createHmac('sha256', key).update(file).digest('hex').slice(0, 32) : '');
    const say = log ? log.on('pkg') : null;

    // Tried once a run each: a file the set will not let this read will not be readable a minute later.
    const tried = {};

    const pathOf = (packageId, ext) => join(dir, `${packageId}.${ext}`);

    const stored = () => {
        try {
            return readdirSync(dir).filter((name) => FILE.test(name));
        } catch (e) {
            return [];
        }
    };

    // Counted once from disk, then kept up to date as icons are written and removed.
    let counted = null;

    const sizeOf = (name) => {
        try {
            return statSync(join(dir, name)).size;
        } catch (e) {
            return 0;
        }
    };

    const total = () => {
        if (counted === null) counted = recount();
        return counted;
    };

    const recount = () => stored().reduce((sum, name) => {
        try {
            return sum + statSync(join(dir, name)).size;
        } catch (e) {
            return sum;
        }
    }, 0);

    const drop = (packageId) => ['png', 'jpg'].forEach((ext) => {
        if (index) index.delete(packageId);
        const bytes = sizeOf(`${packageId}.${ext}`);
        try {
            unlinkSync(pathOf(packageId, ext));
            if (counted !== null) counted -= bytes;
        } catch (e) { /* not there */ }
    });

    const keep = (packageId, bytes) => {
        const ext = kindOf(bytes);
        if (!PACKAGE_ID.test(String(packageId)) || !ext) return false;

        // The icon it replaces does not count against the total.
        const replaced = sizeOf(`${packageId}.png`) + sizeOf(`${packageId}.jpg`);
        if (total() - replaced + bytes.length > MAX_TOTAL) return false;

        try {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            drop(packageId);
            writeFileSync(pathOf(packageId, ext), bytes);
            counted += bytes.length;
            indexed().set(packageId, { file: `${packageId}.${ext}`, at: Date.now() });
            return true;
        } catch (e) {
            if (say) say.debug(`could not keep the icon of ${packageId}: ${e.message}`);
            return false;
        }
    };

    // The icon inside a package, after any customisation: what the TV shows. Read out before the package
    // is let go, and kept once the install succeeds.
    const iconOf = (archive, identity) => {
        if (!archive || !identity || !identity.iconPath) return null;

        const path = String(identity.iconPath).replace(/^\.?\//, '');
        const inside = identity.isWgt ? path : `shared/res/${path}`;

        try {
            const bytes = zip.read(zip.fromBuffer(archive), inside);
            return kindOf(bytes) ? Buffer.from(bytes) : null;
        } catch (e) {
            return null;
        }
    };

    // The same, out of a package on disk: read by seeking, never loaded whole.
    const iconOfFile = (path, identity) => {
        if (!path || !identity || !identity.iconPath) return null;

        const { openSync, fstatSync, readSync, closeSync } = require('fs');
        const inside = identity.isWgt ? String(identity.iconPath).replace(/^\.?\//, '') : `shared/res/${String(identity.iconPath).replace(/^\.?\//, '')}`;

        let handle = null;
        try {
            handle = openSync(path, 'r');
            const bytes = zip.read(zip.fromFile(handle, fstatSync(handle).size, readSync), inside);
            return kindOf(bytes) ? Buffer.from(bytes) : null;
        } catch (e) {
            return null;
        } finally {
            if (handle !== null) closeSync(handle);
        }
    };

    const fromArchive = (archive, identity) => {
        const bytes = iconOf(archive, identity);
        return bytes ? keep(identity.packageId, bytes) : false;
    };

    // From the file the television names for an app, read only under its own apps directory.
    const fromTv = (packageId, iconPath) => {
        if (tried[packageId] || !iconPath || !PACKAGE_ID.test(String(packageId))) return false;
        tried[packageId] = true;

        const ALLOWED = /^\/opt\/(usr\/)?(apps|share\/icons)\//;
        const path = String(iconPath);
        if (!ALLOWED.test(path) || path.indexOf('..') !== -1) return false;

        try {
            // Where it really is, links followed, still under the apps or the icons; a regular file no larger
            // than an icon is kept at — checked before it is read, so a huge file is never pulled into memory.
            const real = realpathSync(path);
            if (!ALLOWED.test(real)) return false;

            const found = statSync(real);
            if (!found.isFile() || found.size > MAX_ICON) return false;

            return keep(packageId, readFileSync(real));
        } catch (e) {
            return false;
        }
    };

    // What is kept, by package id, known without asking the disk on every catalog message: learned from
    // the directory once, then kept up to date by keep, drop and prune.
    let index = null;

    const indexed = () => {
        if (index) return index;
        index = new Map();
        stored().forEach((name) => {
            const parts = FILE.exec(name);
            try {
                index.set(parts[1], { file: name, at: statSync(join(dir, name)).mtime.getTime() });
            } catch (e) { /* gone meanwhile */ }
        });
        return index;
    };

    const has = (packageId) => indexed().get(packageId) || null;

    // The address the phone loads it from; the time in it changes when the picture does.
    const urlOf = (packageId) => {
        const found = has(packageId);
        return found ? `/icons/${found.file}?v=${found.at}&t=${tokenOf(found.file)}` : null;
    };

    const read = (file, token = '') => {
        const name = FILE.exec(String(file));
        if (!name) return null;

        if (key) {
            const wanted = Buffer.from(tokenOf(String(file)));
            const given = Buffer.from(String(token || ''));
            if (given.length !== wanted.length || !require('crypto').timingSafeEqual(given, wanted)) return null;
        }

        try {
            return { bytes: readFileSync(join(dir, `${name[1]}.${name[2]}`)), type: name[2] === 'png' ? 'image/png' : 'image/jpeg' };
        } catch (e) {
            return null;
        }
    };

    // Only when the set has answered with what it holds: an empty answer from a failed listing is not
    // "everything was uninstalled".
    const prune = (installedIds) => {
        if (!installedIds || !installedIds.length) return 0;

        const keepIds = {};
        installedIds.forEach((id) => { keepIds[id] = true; });

        return stored().filter((name) => !keepIds[FILE.exec(name)[1]])
            .filter((name) => {
                const bytes = sizeOf(name);
                try {
                    unlinkSync(join(dir, name));
                    if (counted !== null) counted -= bytes;
                    if (index) index.delete(FILE.exec(name)[1]);
                    return true;
                } catch (e) {
                    return false;
                }
            }).length;
    };

    return { iconOf, iconOfFile, keep, fromArchive, fromTv, has, urlOf, read, prune, drop, MAX_ICON, MAX_TOTAL };
};

module.exports = { createAppIcons, kindOf, MAX_ICON, MAX_TOTAL };
