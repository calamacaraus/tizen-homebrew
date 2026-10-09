'use strict';

// Read without unzipping and without an XML parser: xml2js cost 99KB to extract two attributes.
// The zip side lives in zip.js, which reads both ways a package can be written.

const zip = require('./zip.js');

// A Buffer is the ordinary case; a zip.js source is how a file on a stick is read without loading it.
const sourceOf = (archive) => (Buffer.isBuffer(archive) ? zip.fromBuffer(archive) : archive);

const readFromZip = (archive, wanted) => zip.read(sourceOf(archive), wanted);

const identify = (archive) => {
    const attribute = (xml, tag, key) => {
        const element = new RegExp(`<${tag}\\b[^>]*>`).exec(xml);
        if (!element) return null;
        const found = new RegExp(`\\b${key}="([^"]*)"`).exec(element[0]);
        return found ? found[1] : null;
    };

    const widget = readFromZip(archive, 'config.xml');

    if (widget) {
        const xml = widget.toString('utf8');
        const packageId = attribute(xml, 'tizen:application', 'package');

        if (!packageId) throw badPackage('config.xml declares no package id.');

        const named = /<name\b[^>]*>([^<]*)<\/name>/.exec(xml);

        return checked({
            packageId,
            appId: attribute(xml, 'tizen:application', 'id'),
            name: named ? named[1].trim() : null,
            version: attribute(xml, 'widget', 'version'),
            iconPath: attribute(xml, 'icon', 'src'),
            requires: attribute(xml, 'tizen:application', 'required_version'),
            isWgt: true
        }, 'config.xml');
    }

    const native = readFromZip(archive, 'tizen-manifest.xml');

    if (native) {
        const xml = native.toString('utf8');
        const packageId = attribute(xml, 'manifest', 'package');

        if (!packageId) throw badPackage('tizen-manifest.xml declares no package id.');

        const icon = /<icon\b[^>]*>([^<]*)<\/icon>/.exec(xml);

        return checked({
            packageId,
            appId: attribute(xml, 'ui-application', 'appid'),
            name: null,
            version: attribute(xml, 'manifest', 'version'),
            iconPath: icon ? icon[1].trim() : null,
            requires: attribute(xml, 'manifest', 'api-version'),
            isWgt: false
        }, 'tizen-manifest.xml');
    }

    throw badPackage('No config.xml or tizen-manifest.xml — this is not a Tizen package.');
};

// A package id goes into the install command, so it is held to what Tizen itself allows: a widget's is ten
// letters and digits, a native one's a reverse-domain name. Anything else — a space, a quote, a semicolon —
// is a package built to run something on the television, and is refused before it gets near a shell.
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const checked = (identity, manifestName) => {
    if (!PACKAGE_ID.test(identity.packageId)) {
        throw badPackage(`${manifestName} declares a package id Tizen does not allow ("${String(identity.packageId).slice(0, 40)}").`);
    }

    if (identity.appId !== null && !APP_ID.test(identity.appId)) {
        throw badPackage(`${manifestName} declares an application id Tizen does not allow.`);
    }

    return identity;
};

const badPackage = (message) => Object.assign(new Error(message), { code: 'badPackage' });

module.exports = { identify, readFromZip, PACKAGE_ID };
