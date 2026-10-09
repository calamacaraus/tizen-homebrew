'use strict';

// Every inbound message is validated: the reference implementation's bare integer enum made a
// missing `break` in a switch silently destructive.

const Inbound = {
    HELLO: 'hello',                 // { pin }
    GET_STATE: 'getState',          // -
    WATCH: 'watch',                 // { logsSince? } — push the log and the device state as they change
    GET_CATALOG: 'getCatalog',      // { refresh? }
    CHECK_UPDATES: 'checkUpdates',  // { id? }
    INSTALL: 'install',             // { source: 'catalog'|'github'|'url'|'file', ref, asset?, confirm? } — asset: an exact release file name; confirm: replace an app installed from elsewhere
    UPDATE_ALL: 'updateAll',        // { includeRebuilt? } — install every app with an update, one after another
    LIST_RELEASE: 'listRelease',    // { ref: 'owner/repo' } — every package file in its newest release
    GET_REPOSITORIES: 'getRepositories', // { check? } — check: the id of one repository to ask again now
    ADD_REPOSITORY: 'addRepository',     // { ref: 'owner/repo' | https catalog URL }
    REMOVE_REPOSITORY: 'removeRepository', // { id }
    GET_SETTINGS: 'getSettings',    // -
    SET_SETTINGS: 'setSettings',    // { autoUpdate?: 'off'|'check'|'install' }
    GET_CUSTOMIZATIONS: 'getCustomizations', // -
    SET_CUSTOMIZATION: 'setCustomization',   // { packageId, name?, icon?: { type, data }, reset?, apply? }
    LIST_DIR: 'listDir',            // { path }
    SUBMIT_ACCESS_INFO: 'submitAccessInfo', // { accessToken, userId, email }
    FORGET_CERTS: 'forgetCerts',    // -
    SET_RELAY: 'setRelay',          // { enabled, persist? }
    RELAY_EXEC: 'relayExec'         // { id, command, timeout? }
};

const Outbound = {
    HELLO: 'hello',                 // { ok, needsPin } — plus { pin, port, addresses, url, build } on loopback
    STATE: 'state',                 // DeviceState
    LOG: 'log',                     // { lines: [LogLine], uptime }
    CATALOG: 'catalog',             // { entries: [CatalogEntry], others: [installed, no list names it], stale, source, repositories }
    RELEASE: 'release',             // { repo, tag, publishedAt, assets: [{ name, size, sha256 }] }
    REPOSITORIES: 'repositories',   // { repositories: [Repository] }
    SETTINGS: 'settings',           // { autoUpdate, lastCheck, lastResult }
    UPDATE_RUN: 'updateRun',        // { running, index, total, current?, updated: [], failed: [], trigger }
    CUSTOMIZATIONS: 'customizations', // { items: { [packageId]: { name, icon (data URI) } } }
    PROGRESS: 'progress',           // { phase, detail?, identity? }
    DONE: 'done',                   // { packageId, appId }
    ERROR: 'error',                 // { code, message, remedy?, fatal }
    DIR: 'dir',                     // [{ name, path, isDirectory, size?, identity? }]
    NEEDS_CERTS: 'needsCerts',      // { ip }
    RELAY_STATE: 'relayState',      // { enabled }
    RELAY_DATA: 'relayData',        // { id, chunk }
    RELAY_END: 'relayEnd'           // { id, output, truncated? }
};

const Phase = {
    PROBING: 'probing',
    FETCHING: 'fetching',
    RESIGNING: 'resigning',
    STAGING: 'staging',
    INSTALLING: 'installing'
};

// Stable identifiers the UI maps to translated strings; every code the service throws belongs here.
const ErrorCode = {
    BAD_MESSAGE: 'badMessage',
    UNAUTHORIZED: 'unauthorized',
    DEBUG_MODE_OFF: 'debugModeOff',
    DEBUG_IP_WRONG: 'debugIpWrong',
    SDB_REFUSED: 'sdbRefused',
    SDB_TIMEOUT: 'sdbTimeout',
    SDB_UNREACHABLE: 'sdbUnreachable',
    NOT_FOUND: 'notFound',
    DOWNLOAD_FAILED: 'downloadFailed',
    BAD_PACKAGE: 'badPackage',
    CERTS_MISSING: 'certsMissing',
    RESIGN_FAILED: 'resignFailed',
    RELAY_DISABLED: 'relayDisabled',
    LOCKED_OUT: 'lockedOut',
    INTERNAL: 'internal',

    INSTALL_FAILED: 'installFailed',
    CERT_REJECTED: 'certRejected',
    AUTHOR_MISMATCH: 'authorMismatch',
    CERT_CHAIN_INVALID: 'certChainInvalid',
    SECURITY_ERROR: 'securityError',
    PRIVILEGE_TOO_HIGH: 'privilegeTooHigh',

    CHECKSUM_MISMATCH: 'checksumMismatch',
    TOO_LARGE: 'tooLarge',
    BUSY: 'busy',
    SAVED_NOT_APPLIED: 'savedNotApplied',
    REPLACES_OTHER: 'replacesOther',
    NEEDS_NEWER_TIZEN: 'needsNewerTizen',
    PACKAGE_MISMATCH: 'packageMismatch'
};

function ProtocolError(code, message) {
    const e = new Error(message || code);
    e.code = code;
    e.isProtocolError = true;
    return e;
}

const INSTALL_SOURCES = ['catalog', 'github', 'url', 'file'];

const AUTO_UPDATE = ['off', 'check', 'install'];

// Long enough for any real reference, short enough that nothing is stored or logged by the kilobyte.
const MAX_REF = 512;

const shortString = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_REF;

function parse(raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch (e) {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'Message was not valid JSON.');
    }

    if (!msg || typeof msg.type !== 'string') {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'Message had no type.');
    }

    let known = false;
    for (const k in Inbound) {
        if (Inbound[k] === msg.type) { known = true; break; }
    }
    if (!known) {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, `Unknown message type: ${msg.type}`);
    }

    // A payload is an object or nothing: a string or a number would make every `'x' in payload` below throw.
    if (msg.payload !== undefined && msg.payload !== null &&
        (typeof msg.payload !== 'object' || Array.isArray(msg.payload))) {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'A message payload is an object.');
    }

    const payload = msg.payload || {};

    if (msg.type === Inbound.INSTALL) {
        if (INSTALL_SOURCES.indexOf(payload.source) === -1) {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, `Unknown install source: ${payload.source}`);
        }
        if (!shortString(payload.ref)) {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, 'Install ref must be a non-empty string.');
        }
        if ('asset' in payload && payload.asset !== null && !shortString(payload.asset)) {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, 'An asset is the exact name of one release file.');
        }
        if ('expect' in payload && payload.expect !== null && !shortString(payload.expect)) {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, 'expect is a package id.');
        }
        if ('confirm' in payload && typeof payload.confirm !== 'boolean') {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, 'confirm is true or false.');
        }
        if ('asset' in payload && payload.asset !== null && payload.source !== 'github') {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, 'Only a GitHub install picks a release file.');
        }
    }

    if ((msg.type === Inbound.LIST_RELEASE || msg.type === Inbound.ADD_REPOSITORY) && !shortString(payload.ref)) {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, `${msg.type} requires a ref.`);
    }

    if (msg.type === Inbound.GET_REPOSITORIES && 'check' in payload && payload.check !== null && !shortString(payload.check)) {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'check is the id of one repository.');
    }

    if (msg.type === Inbound.REMOVE_REPOSITORY && !shortString(payload.id)) {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'removeRepository requires the id of one repository.');
    }

    if (msg.type === Inbound.SET_CUSTOMIZATION) {
        if (!shortString(payload.packageId)) throw ProtocolError(ErrorCode.BAD_MESSAGE, 'setCustomization needs a packageId.');
        if ('name' in payload && payload.name !== null && (typeof payload.name !== 'string' || payload.name.length > 200)) {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, 'A name is a short string, or null.');
        }
        if ('icon' in payload && payload.icon !== null &&
            (typeof payload.icon !== 'object' || typeof payload.icon.type !== 'string' || typeof payload.icon.data !== 'string')) {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, 'An icon is { type, data }, or null.');
        }
        ['reset', 'apply'].forEach((flag) => {
            if (flag in payload && typeof payload[flag] !== 'boolean') {
                throw ProtocolError(ErrorCode.BAD_MESSAGE, `${flag} is a boolean.`);
            }
        });
    }

    if (msg.type === Inbound.UPDATE_ALL && 'includeRebuilt' in payload && typeof payload.includeRebuilt !== 'boolean') {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'updateAll takes includeRebuilt as a boolean, or nothing.');
    }

    if (msg.type === Inbound.SET_SETTINGS && 'autoUpdate' in payload && AUTO_UPDATE.indexOf(payload.autoUpdate) === -1) {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, `autoUpdate is one of ${AUTO_UPDATE.join(', ')}.`);
    }

    if (msg.type === Inbound.CHECK_UPDATES && 'id' in payload && payload.id !== null &&
        typeof payload.id !== 'string') {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'checkUpdates takes the id of one app, or nothing at all.');
    }

    if (msg.type === Inbound.LIST_DIR && typeof payload.path !== 'string') {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'listDir requires a path.');
    }

    if (msg.type === Inbound.RELAY_EXEC) {
        if (typeof payload.id !== 'string' || !payload.id) {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, 'relayExec requires an id to correlate output with.');
        }
        if (typeof payload.command !== 'string' || !payload.command.trim()) {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, 'relayExec requires a command.');
        }
    }

    if (msg.type === Inbound.WATCH && 'logsSince' in payload && payload.logsSince !== null &&
        typeof payload.logsSince !== 'number') {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'watch takes the sequence number to resume from, or nothing.');
    }

    if (msg.type === Inbound.SET_RELAY && typeof payload.enabled !== 'boolean') {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'setRelay requires enabled to be a boolean.');
    }

    return { type: msg.type, payload };
}

function encode(type, payload) {
    return JSON.stringify({ type, payload: payload === undefined ? null : payload });
}

module.exports = {
    Inbound,
    Outbound,
    Phase,
    ErrorCode,
    ProtocolError,
    AUTO_UPDATE,
    MAX_REF,
    parse,
    encode
};
