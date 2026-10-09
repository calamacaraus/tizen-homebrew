'use strict';

const { readFileSync, writeFileSync, existsSync, statSync } = require('fs');

const { getJson } = require('../remote/fetch.js');
const { took } = require('../obs/units.js');

const CACHE_TTL = 6 * 60 * 60 * 1000;

const quiet = { info: () => {}, ok: () => {}, warn: () => {}, err: () => {}, debug: () => {} };

// Guessed, not required: an app with no logo.png answers 404 and the phone draws a monogram.
const logoFor = (source) => (source.type === 'github'
    ? `https://raw.githubusercontent.com/${source.ref}/HEAD/logo.png`
    : null);

// An id ends up in markup attributes and in config keys, so it is held to a plain alphabet.
const ID = /^[A-Za-z0-9._-]{1,64}$/;

const usable = (entry) => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.name !== 'string') return null;
    if (!ID.test(entry.id) || entry.name.length > 120) return null;
    if (!entry.source || !['github', 'url'].includes(entry.source.type)) return null;
    if (typeof entry.source.ref !== 'string') return null;

    const source = { type: entry.source.type, ref: entry.source.ref };

    if (source.type === 'github' && typeof entry.source.asset === 'string') source.asset = entry.source.asset;
    if (source.type === 'github' && entry.source.exact === true) source.exact = true;

    // Only https is fetched, so a catalog that lists anything else lists something that cannot install.
    if (source.type === 'url' && !/^https:\/\//.test(source.ref)) return null;

    return {
        id: entry.id,
        name: entry.name,
        description: typeof entry.description === 'string' ? entry.description.slice(0, 300) : '',
        version: typeof entry.version === 'string' ? entry.version : null,
        forTizen: require('./compat.js').fromName(entry.tizen, entry.name, entry.source && entry.source.asset),
        packageId: typeof entry.packageId === 'string' ? entry.packageId : null,
        sha256: typeof entry.sha256 === 'string' && /^(sha256:)?[0-9a-f]{64}$/i.test(entry.sha256)
            ? entry.sha256.toLowerCase().replace(/^sha256:/, '')
            : null,
        icon: typeof entry.icon === 'string' && entry.icon.startsWith('https://')
            ? entry.icon
            : logoFor(source),
        source
    };
};

const createCatalog = ({ url, cachePath, log }) => {
    const say = log ? log.on('cat') : quiet;

    const readCache = () => {
        if (!existsSync(cachePath)) return null;

        try {
            return {
                entries: JSON.parse(readFileSync(cachePath, 'utf8')),
                age: Date.now() - statSync(cachePath).mtime.getTime()
            };
        } catch (e) {
            return null;
        }
    };

    const fetch = async ({ refresh = false } = {}) => {
        const cached = readCache();

        if (!refresh && cached && cached.age < CACHE_TTL) {
            say.info(`${cached.entries.length} apps from the cache, ${took(cached.age)} old`);
            return { entries: cached.entries, stale: false, source: 'cache', fetchedAt: Date.now() - cached.age };
        }

        const began = Date.now();

        try {
            say.info(`fetching ${url}`);

            const body = await getJson(url, { headers: { 'user-agent': 'TizenHomebrew/1.0' }, httpsOnly: /^https:/.test(url) });
            const listed = Array.isArray(body) ? body : body && body.apps;

            if (!Array.isArray(listed)) throw new Error('Catalog was not a list of apps.');

            const entries = listed.map(usable).filter(Boolean);

            try {
                writeFileSync(cachePath, JSON.stringify(entries));
            } catch (e) {
                say.warn(`could not cache the catalog at ${cachePath}: ${e.message}`);
            }

            say.ok(`${entries.length} apps${listed.length !== entries.length
                ? `, ${listed.length - entries.length} of ${listed.length} rejected as malformed` : ''} ` +
                `in ${took(Date.now() - began)}`);

            return { entries, stale: false, source: 'network', fetchedAt: Date.now() };
        } catch (error) {
            if (cached) {
                say.warn(`origin unreachable (${error.message}) — showing ${cached.entries.length} cached apps instead`);
                return { entries: cached.entries, stale: true, source: 'cache', error: error.message, fetchedAt: Date.now() - cached.age };
            }

            say.err(`no catalog and no cache: ${error.message}`);
            throw Object.assign(new Error(`Could not load the app catalog: ${error.message}`), { code: 'downloadFailed' });
        }
    };

    return { fetch };
};

module.exports = { createCatalog, usable, logoFor, ID };
