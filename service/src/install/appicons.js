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
// Only PNG and JPEG, a few hundred kilobytes each, a few megabytes in all, and only for what is installed:
// an app that is gone takes its icon with it.

const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } = require('fs');
const { join } = require('path');

const zip = require('./zip.js');

const MAX_ICON = 256 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.(png|jpg)$/;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const kindOf = (bytes) => {
    if (!bytes || bytes.length < 8 || bytes.length > MAX_ICON) return null;
    if (bytes.slice(0, 8).equals(PNG)) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    return null;
};

const createAppIcons = ({ dir, log }) => {
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

    const total = () => stored().reduce((sum, name) => {
        try {
            return sum + statSync(join(dir, name)).size;
        } catch (e) {
            return sum;
        }
    }, 0);

    const drop = (packageId) => ['png', 'jpg'].forEach((ext) => {
        try { unlinkSync(pathOf(packageId, ext)); } catch (e) { /* not there */ }
    });

    const keep = (packageId, bytes) => {
        const ext = kindOf(bytes);
        if (!PACKAGE_ID.test(String(packageId)) || !ext) return false;
        if (total() + bytes.length > MAX_TOTAL) return false;

        try {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            drop(packageId);
            writeFileSync(pathOf(packageId, ext), bytes);
            return true;
        } catch (e) {
            if (say) say.debug(`could not keep the icon of ${packageId}: ${e.message}`);
            return false;
        }
    };

    // From the archive just installed, after any customisation: what the TV shows is what this keeps.
    const fromArchive = (archive, identity) => {
        if (!identity || !identity.iconPath) return false;

        const path = String(identity.iconPath).replace(/^\.?\//, '');
        const inside = identity.isWgt ? path : `shared/res/${path}`;

        try {
            return keep(identity.packageId, zip.read(zip.fromBuffer(archive), inside));
        } catch (e) {
            return false;
        }
    };

    // From the file the television names for an app, read only under its own apps directory.
    const fromTv = (packageId, iconPath) => {
        if (tried[packageId] || !iconPath || !PACKAGE_ID.test(String(packageId))) return false;
        tried[packageId] = true;

        const path = String(iconPath);
        if (!/^\/opt\/(usr\/)?(apps|share\/icons)\//.test(path) || path.indexOf('..') !== -1) return false;

        try {
            return keep(packageId, readFileSync(path));
        } catch (e) {
            return false;
        }
    };

    const has = (packageId) => {
        for (const ext of ['png', 'jpg']) {
            try {
                const at = statSync(pathOf(packageId, ext)).mtime.getTime();
                return { file: `${packageId}.${ext}`, at };
            } catch (e) { /* the other kind, or none */ }
        }
        return null;
    };

    // The address the phone loads it from; the time in it changes when the picture does.
    const urlOf = (packageId) => {
        const found = has(packageId);
        return found ? `/icons/${found.file}?v=${found.at}` : null;
    };

    const read = (file) => {
        const name = FILE.exec(String(file));
        if (!name) return null;

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
                try {
                    unlinkSync(join(dir, name));
                    return true;
                } catch (e) {
                    return false;
                }
            }).length;
    };

    return { fromArchive, fromTv, has, urlOf, read, prune, drop, MAX_ICON, MAX_TOTAL };
};

module.exports = { createAppIcons, kindOf, MAX_ICON, MAX_TOTAL };
