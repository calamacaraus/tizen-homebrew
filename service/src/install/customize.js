'use strict';

// Your own icon and name for an app, kept across every install of it. A customisation is stored by
// package id — the one thing that stays the same whichever catalog, collection, release file or upload
// the app arrives from — and applied to the archive after it is identified and before it is re-signed,
// so the signature covers the changed files and the television accepts them like any other.
//
// For a widget that means config.xml: every <name> gets the new text, and every <icon> points at the new
// image, which is added under a name of its own. A native .tpk names its label and icon in
// tizen-manifest.xml, and its icon lives under shared/res/.

const MAX_ICON = 384 * 1024;
const MAX_NAME = 60;
const PACKAGE_ID = /^[A-Za-z0-9._-]{1,64}$/;

const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg' };

const refuse = (code, message) => Object.assign(new Error(message), { code });

const escapeXml = (text) => String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Checked where it is set, so what reaches the pipeline is already a name and an image of a known kind.
const validate = ({ packageId, name, icon }) => {
    if (!PACKAGE_ID.test(String(packageId || ''))) throw refuse('badMessage', 'That is not a package id.');

    const cleanName = name === null || name === undefined ? null : String(name).replace(/[\u0000-\u001f]/g, '').trim();

    if (cleanName !== null && cleanName.length > MAX_NAME) {
        throw refuse('badMessage', `A name is at most ${MAX_NAME} characters.`);
    }

    let image = null;

    if (icon) {
        const extension = TYPES[icon.type];
        if (!extension) throw refuse('badMessage', 'An icon is a PNG or a JPEG.');

        const bytes = Buffer.from(String(icon.data || ''), 'base64');

        if (!bytes.length) throw refuse('badMessage', 'The icon was empty.');
        if (bytes.length > MAX_ICON) throw refuse('tooLarge', `An icon is at most ${Math.round(MAX_ICON / 1024)}KB.`);

        // The bytes have to be what the type says, or the television shows a blank tile.
        const png = bytes.length > 8 && bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

        if ((extension === 'png' && !png) || (extension === 'jpg' && !jpeg)) {
            throw refuse('badMessage', `That file is not a ${extension === 'png' ? 'PNG' : 'JPEG'}.`);
        }

        image = { type: icon.type, data: bytes.toString('base64') };
    }

    return { packageId, name: cleanName || null, icon: image };
};

const iconFileOf = (custom) => `homebrew-icon.${TYPES[custom.icon.type]}`;

// Icons are kept as files beside the configuration rather than inside it: the configuration is read on
// every request, and a few hundred kilobytes of base64 each would make every one of those slow.
const { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } = require('fs');
const { join } = require('path');

const MAX_CUSTOMIZED = 64;

// What all icons together may weigh: they are sent to a phone whole when it pairs.
const MAX_ICONS_TOTAL = 6 * 1024 * 1024;

const storedSize = (configDir, stored) => {
    const bytes = iconBytesOf(configDir, stored);
    return bytes ? bytes.length : 0;
};

const iconsDir = (configDir) => join(configDir, 'homebrewIcons');

const storeIcon = (configDir, packageId, icon) => {
    const dir = iconsDir(configDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const file = `${packageId}.${TYPES[icon.type]}`;
    writeFileSync(join(dir, file), Buffer.from(icon.data, 'base64'), { mode: 0o600 });

    return { type: icon.type, file };
};

const dropIcon = (configDir, stored) => {
    if (!stored || !stored.file) return;
    try {
        unlinkSync(join(iconsDir(configDir), stored.file));
    } catch (e) { /* already gone */ }
};

// Icon files no customisation points at any more — a write that was interrupted, say. Your own icon for an
// app that is not installed now is kept on purpose: installing it again brings it back.
const sweepIcons = (configDir, customizations) => {
    const wanted = {};
    Object.keys(customizations || {}).forEach((id) => {
        const icon = customizations[id] && customizations[id].icon;
        if (icon && icon.file) wanted[icon.file] = true;
    });

    let names = [];
    try {
        names = require('fs').readdirSync(iconsDir(configDir));
    } catch (e) {
        return 0;
    }

    return names.filter((name) => !wanted[name]).filter((name) => {
        try {
            unlinkSync(join(iconsDir(configDir), name));
            return true;
        } catch (e) {
            return false;
        }
    }).length;
};

// The bytes of a stored icon, from its file — or, for one stored before files, from the configuration.
const iconBytes = (configDir, stored) => iconBytesOf(configDir, stored);

function iconBytesOf(configDir, stored) {
    if (!stored) return null;
    if (stored.data) return Buffer.from(stored.data, 'base64');

    try {
        return readFileSync(join(iconsDir(configDir), String(stored.file).replace(/[^A-Za-z0-9._-]/g, '')));
    } catch (e) {
        return null;
    }
}

// <name>…</name> and <name xml:lang="…">…</name> alike: the television shows whichever matches its language.
// Replaced by a function, never a replacement string: a name with `$&` or `$'` in it would otherwise splice
// the document into itself.
const renameWidget = (xml, name) => xml.replace(/(<name\b[^>]*>)[^<]*(<\/name>)/g,
    (_match, open, close) => open + escapeXml(name) + close);

// Every <icon src="…"> points at the new file; sizes the old one declared do not describe it.
const reiconWidget = (xml, file) => {
    const pointed = xml.replace(/<icon\b[^>]*?\/?>/g, (tag) => {
        const closes = /\/>$/.test(tag);
        const kept = tag
            .replace(/\s(src|width|height)\s*=\s*("[^"]*"|'[^']*')/g, '')
            .replace(/\s*\/?>$/, '');
        return `${kept} src="${file}"${closes ? '/>' : '>'}`;
    });

    if (pointed !== xml) return pointed;

    // No icon declared at all: one is added beside the name.
    return xml.replace(/(<\/name>)/, (close) => `${close}\n    <icon src="${file}"/>`);
};

// The paths every <icon src="…"> names, relative to the archive root, without anything that would leave it.
const declaredIcons = (xml) => {
    const found = [];
    xml.replace(/<icon\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)')/g, (_match, _quoted, double, single) => {
        const path = String(double !== undefined ? double : single).replace(/^\.?\//, '');
        if (path && !/(^|\/)\.\.(\/|$)/.test(path) && !/^[a-z]+:/i.test(path) && found.indexOf(path) === -1) found.push(path);
        return '';
    });
    return found;
};

const sameKind = (path, type) => (type === 'image/png' ? /\.png$/i : /\.jpe?g$/i).test(path);

const relabelNative = (xml, name) => xml.replace(/(<label\b[^>]*>)[^<]*(<\/label>)/g,
    (_match, open, close) => open + escapeXml(name) + close);

const reiconNative = (xml, file) => xml.replace(/(<icon\b[^>]*>)[^<]*(<\/icon>)/g,
    (_match, open, close) => open + file + close);

// A customised copy of the archive, or the archive itself when there is nothing to change. `custom.icon`
// carries its bytes (`bytes`) by the time it gets here; an icon whose file has gone is simply left out.
const apply = async (archive, identity, custom) => {
    const bytes = custom && custom.icon ? custom.icon.bytes || Buffer.from(custom.icon.data || '', 'base64') : null;
    const icon = bytes && bytes.length ? { type: custom.icon.type, bytes } : null;
    const name = custom ? custom.name : null;

    if (!name && !icon) return { archive, changed: false };

    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(archive);

    const manifestName = identity.isWgt ? 'config.xml' : 'tizen-manifest.xml';
    const manifest = zip.file(manifestName);
    if (!manifest) throw refuse('badPackage', `No ${manifestName} to customise.`);

    let xml = await manifest.async('string');

    if (name) xml = identity.isWgt ? renameWidget(xml, name) : relabelNative(xml, name);

    if (icon) {
        const file = iconFileOf({ icon });

        if (identity.isWgt) {
            // The files the app declared are overwritten too, where they are the same kind of image: a home
            // screen that keeps the icon it knew by its path, or reads the app's own file, still gets the new one.
            declaredIcons(xml).forEach((path) => {
                if (zip.file(path) && sameKind(path, icon.type)) zip.file(path, icon.bytes);
            });

            xml = reiconWidget(xml, file);
            zip.file(file, icon.bytes);
        } else {
            xml = reiconNative(xml, file);
            zip.file(`shared/res/${file}`, icon.bytes);
        }
    }

    zip.file(manifestName, xml);

    return {
        archive: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
        changed: true,
        iconFile: icon ? iconFileOf({ icon }) : null
    };
};

// Which list entry to install again so a change shows: the one that installed this package, by Homebrew's own
// record; failing that — an app installed before that record was kept, by an earlier version say — an entry
// that names this package, the built-in list first. Never a collection's: those name no package id.
const sourceFor = (listed, installedFrom, packageId) => {
    const memory = installedFrom || {};
    const entries = Array.isArray(listed) ? listed : [];

    const remembered = entries.find((entry) => memory[entry.id] && memory[entry.id].packageId === packageId);
    if (remembered) return remembered.id;

    const named = entries.filter((entry) => !entry.collection && entry.packageId === packageId);
    const chosen = named.find((entry) => entry.repository === 'official') || named[0];

    return chosen ? chosen.id : null;
};

module.exports = { sweepIcons, sourceFor, declaredIcons, apply, validate, iconFileOf, renameWidget, reiconWidget, relabelNative, storeIcon, dropIcon, iconBytes,
    storedSize, MAX_ICON, MAX_NAME, MAX_CUSTOMIZED, MAX_ICONS_TOTAL };
