'use strict';

const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, statSync, openSync, writeSync,
    fsyncSync, closeSync, copyFileSync, chmodSync } = require('fs');
const { homedir } = require('os');

const pin = require('./auth/pin.js');

const CONFIG_DIR = process.env.HOMEBREW_CONFIG_DIR || `${homedir()}/share`;
const CONFIG_PATH = `${CONFIG_DIR}/homebrewConfig.json`;

// Where `npm run bootstrap` leaves a pair: sdb refuses to write anywhere else under share/.
const HANDOFF_PATH = `${CONFIG_DIR}/tmp/sdk_tools/homebrewCerts.json`;

const DEFAULTS = {
    pin: null,               // the pairing code, minted once and then kept — see pairingPin below

    // `{ certificates: [pem], key: pem }` each. PEM, because an ASN.1 parser was a third of the bundle.
    author: null,
    distributor: null,
    certDuid: null,          // the first DUID the certificates name, for display
    certDuids: null,         // every DUID they name — `--duidList` is a list
    certCreatedAt: null,
    catalogUrl: null,        // overrides the built-in origin when set
    lastInstalled: [],

    repositories: [],        // added on the phone: { id, kind: 'catalog'|'github', ref, name, addedAt }
    origins: {},             // package id -> where its last install came from, for the phone to show
    installedFrom: {},       // catalog entry id -> { packageId, version, sha256, at } for what this installed

    customizations: {},      // package id -> { name, icon: { type, file } , at } — the image in homebrewIcons/

    autoUpdate: 'check',     // 'off' | 'check' — look daily and say so | 'install' — and install what is newer
    lastUpdateCheck: null,   // ISO time of the last automatic or asked-for check
    lastUpdateResult: null   // { available: [names], updated: [names], failed: [names] }
};

// Parsed once and kept until the file changes: it is read on every catalog message and every install
// step, and holds the certificates, so parsing it each time was most of the cost of a small request.
// Frozen, so code that changes what it read without writing it back fails at once rather than quietly.
let cached = null;

const deepFreeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.keys(value).forEach((key) => deepFreeze(value[key]));
    }
    return value;
};

// Shared by every read of a missing file: frozen, or a push into one of its lists would change what every
// later read sees.
deepFreeze(DEFAULTS);

// A file that will not parse is never written over with defaults: that would replace the signing keys
// and the PIN with nothing. The last good copy is used instead, and the damaged one moved aside for a person
// to look at.
const BACKUP_PATH = `${CONFIG_PATH}.bak`;

const parseFile = (path) => {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size, parsed: deepFreeze(JSON.parse(readFileSync(path, 'utf8'))) };
};

const recover = (error) => {
    console.error(`Config at ${CONFIG_PATH} is unreadable (${error.message}); trying the last good copy`);

    try {
        renameSync(CONFIG_PATH, `${CONFIG_PATH}.damaged-${Date.now()}`);
    } catch (e) { /* already gone */ }

    try {
        const good = parseFile(BACKUP_PATH);
        writeFileSync(`${CONFIG_PATH}.tmp`, JSON.stringify(good.parsed, null, 4), { mode: 0o600 });
        renameSync(`${CONFIG_PATH}.tmp`, CONFIG_PATH);
        cached = parseFile(CONFIG_PATH);
        console.error('Config restored from its last good copy');
        return Object.assign({}, DEFAULTS, cached.parsed);
    } catch (e) {
        cached = null;
        console.error(`No usable copy either (${e.message}); starting from defaults`);
        return Object.assign({}, DEFAULTS);
    }
};

function read() {
    // Missing is a fresh start (a rename never leaves none); only a damaged file is recovered.
    if (!existsSync(CONFIG_PATH)) return Object.assign({}, DEFAULTS);

    try {
        const stat = statSync(CONFIG_PATH);

        if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) cached = parseFile(CONFIG_PATH);

        return Object.assign({}, DEFAULTS, cached.parsed);
    } catch (e) {
        // Only a file that does not parse is damaged. A read that failed for another reason — too many open
        // files, a busy flash — says nothing about the file: the copy last read stands, or the error is
        // raised, rather than a good file being moved aside for a backup one change older.
        if (e instanceof SyntaxError) return recover(e);
        if (cached) return Object.assign({}, DEFAULTS, cached.parsed);
        throw e;
    }
}

function write(config) {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR);
    const tmp = `${CONFIG_PATH}.tmp`;
    const serialized = JSON.stringify(config, null, 4);

    // The private signing keys live in this file, so it is readable by its owner and nobody else — and a
    // leftover temporary file is removed first, since writing into one would keep its old permissions.
    try { unlinkSync(tmp); } catch (e) { /* none */ }

    // Flushed to the flash before it replaces the old file, so power lost a moment later leaves one whole
    // file or the other, never half of the new one.
    const handle = openSync(tmp, 'w', 0o600);
    try {
        writeSync(handle, serialized);
        fsyncSync(handle);
    } finally {
        closeSync(handle);
    }

    // The file it replaces becomes the last good copy.
    if (existsSync(CONFIG_PATH)) {
        try {
            JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
            copyFileSync(CONFIG_PATH, BACKUP_PATH);
            chmodSync(BACKUP_PATH, 0o600);
        } catch (e) { /* not a good copy: the older backup stays */ }
    }

    renameSync(tmp, CONFIG_PATH);

    try {
        const stat = statSync(CONFIG_PATH);
        cached = { mtimeMs: stat.mtimeMs, size: stat.size, parsed: deepFreeze(JSON.parse(serialized)) };
    } catch (e) {
        cached = null;
    }

    return config;
}

function update(patch) {
    return write(Object.assign(read(), patch));
}

// The service starts with the television now, so the code has to outlive a restart: one regenerated
// every start would be readable only off the screen that starting on boot exists to avoid, and every
// paired phone would be dropped by each reboot. It lives beside the signing keys, which are the more
// valuable half of this file by a wide margin.
function pairingPin() {
    const kept = read().pin;

    if (typeof kept === 'string' && kept.length === pin.DIGITS) return kept;

    return update({ pin: pin.generate() }).pin;
}

function hasCertificates(duid) {
    const config = read();
    if (!config.author || !config.distributor) return false;

    const named = config.certDuids || (config.certDuid ? [config.certDuid] : []);

    if (duid && named.length && named.indexOf(duid) === -1) return false;
    return true;
}

function forgetCertificates() {
    return update({
        author: null,
        distributor: null,
        certDuid: null,
        certDuids: null,
        certCreatedAt: null
    });
}

function hasLegacyCertificates() {
    const config = read();
    return Boolean(!config.author && (config.authorCert || config.distributorCert));
}

function adoptHandoff() {
    if (!existsSync(HANDOFF_PATH)) return null;

    try {
        const sent = JSON.parse(readFileSync(HANDOFF_PATH, 'utf8'));

        if (!sent.author || !sent.distributor) return null;

        const devices = Array.isArray(sent.devices) ? sent.devices.filter(Boolean) : [];

        update({
            author: sent.author,
            distributor: sent.distributor,
            certDuid: devices[0] || null,
            certDuids: devices,
            certCreatedAt: new Date().toISOString()
        });

        return devices;
    } catch (e) {
        return null;
    } finally {
        try {
            unlinkSync(HANDOFF_PATH);
        } catch (e) { /* a read-only drop is re-adopted next start, harmlessly */ }
    }
}

function clear() {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
}

module.exports = {
    read,
    write,
    update,
    pairingPin,
    hasCertificates,
    hasLegacyCertificates,
    adoptHandoff,
    forgetCertificates,
    clear,
    CONFIG_DIR,
    CONFIG_PATH,
    HANDOFF_PATH,
    DEFAULTS
};
