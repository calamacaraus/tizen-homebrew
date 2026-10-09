'use strict';

// Everything the phone can install from, as one list: the built-in catalog, plus whatever
// repositories have been added on the phone. A repository is either
//
//   - another catalog, an https URL to JSON in the same shape as catalog/catalog.json, or
//   - a collection, a GitHub `owner/repo` whose newest release carries the packages themselves
//     (collection.js turns each file into an entry).
//
// Each is fetched and cached on its own, so one that is down shows yesterday's list and a note rather
// than taking the others with it. The repositories live in the configuration, beside the certificates,
// so they survive restarts and updates of this app.

const { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, unlinkSync } = require('fs');
const { createHash } = require('crypto');
const { join } = require('path');

const { usable, ID } = require('./catalog.js');
const collection = require('./collection.js');
const sources = require('./sources.js');
const { getJson } = require('../remote/fetch.js');
const { took } = require('../obs/units.js');

const CACHE_TTL = 6 * 60 * 60 * 1000;

// Each costs a GitHub request on a refresh, against sixty an hour for a television nobody signed in from.
const MAX_REPOSITORIES = 16;

const OFFICIAL = 'official';

const quiet = { info: () => {}, ok: () => {}, warn: () => {}, err: () => {}, debug: () => {} };

const refuse = (code, message) => Object.assign(new Error(message), { code });

const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 10);

// What was typed, as a repository — or a refusal that says what would have been accepted.
const classify = (reference) => {
    const typed = String(reference || '').trim();

    if (/^https:\/\//i.test(typed) && !/^https:\/\/(www\.)?github\.com\//i.test(typed)) {
        let parsed;

        try {
            parsed = new URL(typed);
        } catch (e) {
            throw refuse('badMessage', `"${typed}" is not a URL.`);
        }

        return { id: `cat-${hash(parsed.toString())}`, kind: 'catalog', ref: parsed.toString(), name: parsed.host };
    }

    if (/^http:\/\//i.test(typed)) throw refuse('badMessage', 'A catalog has to be served over https.');

    const repo = sources.repoOf(typed);

    if (!repo) {
        throw refuse('badMessage',
            `"${typed}" is neither a GitHub owner/repo nor an https link to a catalog.json.`);
    }

    return { id: `gh-${collection.slug(repo.replace('/', '-'))}`.slice(0, 48), kind: 'github', ref: repo, name: repo };
};

const createLibrary = ({ config, official, cacheDir, log, latestRelease = sources.latestRelease, fetchJson = getJson }) => {
    const say = log ? log.on('cat') : quiet;

    // repository id -> { at, error } for whatever the last load of it found.
    const status = {};

    const repositories = () => {
        const kept = config.read().repositories;
        return Array.isArray(kept) ? kept.filter((repository) => repository && ID.test(repository.id)) : [];
    };

    const cachePathOf = (repository) => join(cacheDir, `homebrewRepo-${repository.id}.json`);

    const readCache = (repository) => {
        const path = cachePathOf(repository);
        if (!existsSync(path)) return null;

        try {
            return { entries: JSON.parse(readFileSync(path, 'utf8')), age: Date.now() - statSync(path).mtime.getTime() };
        } catch (e) {
            return null;
        }
    };

    const writeCache = (repository, entries) => {
        try {
            if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
            writeFileSync(cachePathOf(repository), JSON.stringify(entries));
        } catch (e) {
            say.warn(`could not cache ${repository.ref}: ${e.message}`);
        }
    };

    // A catalog's entries are renamed into the repository's own space, so two catalogs that both list
    // an `app` cannot answer for each other.
    const fromCatalog = async (repository) => {
        const body = await fetchJson(repository.ref, { headers: { 'user-agent': 'TizenHomebrew/1.0' }, httpsOnly: true });
        const listed = Array.isArray(body) ? body : body && body.apps;

        if (!Array.isArray(listed)) throw new Error('That URL did not answer with a catalog (a list of apps).');

        return listed.map(usable).filter(Boolean).map((entry) => ({
            ...entry,
            id: `${repository.id}.${entry.id}`,
            repository: repository.id
        }));
    };

    const fromCollection = async (repository) => collection.expand(repository, await latestRelease(repository.ref));

    const load = async (repository, refresh) => {
        const cached = readCache(repository);

        if (!refresh && cached && cached.age < CACHE_TTL) {
            return { entries: cached.entries, stale: false };
        }

        const began = Date.now();

        try {
            const entries = repository.kind === 'catalog' ? await fromCatalog(repository) : await fromCollection(repository);

            writeCache(repository, entries);
            status[repository.id] = { at: Date.now(), error: null };

            say.ok(`${repository.ref}: ${entries.length} ${entries.length === 1 ? 'app' : 'apps'} in ${took(Date.now() - began)}`);

            return { entries, stale: false };
        } catch (error) {
            status[repository.id] = { at: Date.now(), error: error.message };

            if (cached) {
                say.warn(`${repository.ref} unreachable (${error.message}) — showing ${cached.entries.length} cached apps`);
                return { entries: cached.entries, stale: true, error: error.message };
            }

            say.warn(`${repository.ref}: ${error.message}`);
            return { entries: [], stale: true, error: error.message };
        }
    };

    const describe = (repository, loaded) => ({
        id: repository.id,
        kind: repository.kind,
        ref: repository.ref,
        name: repository.name || repository.ref,
        count: loaded ? loaded.entries.length : null,
        stale: loaded ? Boolean(loaded.stale) : false,
        error: (loaded && loaded.error) || (status[repository.id] && status[repository.id].error) || null,
        checkedAt: status[repository.id] ? new Date(status[repository.id].at).toISOString() : null
    });

    // `refresh` is everything, or only the collections — a check for updates asks GitHub what their
    // newest releases hold, and leaves plain catalogs to their cache.
    const fetch = async ({ refresh = false } = {}) => {
        const kept = repositories();
        const everything = refresh === true;

        const base = await official.fetch({ refresh: everything }).then(
            (result) => result,
            (error) => {
                // With nothing else to show, a dead origin is still the failure it always was.
                if (!kept.length) throw error;
                return { entries: [], stale: true, source: 'none', error: error.message };
            });

        const loaded = [];

        for (const repository of kept) {
            const fresh = everything || (refresh === 'collections' && repository.kind === 'github');
            loaded.push({ repository, result: await load(repository, fresh) });
        }

        const entries = base.entries.map((entry) => ({ ...entry, repository: OFFICIAL }))
            .concat(...loaded.map(({ result }) => result.entries));

        return {
            entries,
            stale: Boolean(base.stale),
            source: base.source,
            error: base.error || null,
            repositories: [{ id: OFFICIAL, kind: 'catalog', ref: null, name: 'Tizen Homebrew', count: base.entries.length,
                stale: Boolean(base.stale), error: base.error || null, builtIn: true }]
                .concat(loaded.map(({ repository, result }) => describe(repository, result)))
        };
    };

    const add = async (reference) => {
        const repository = classify(reference);
        const kept = repositories();

        if (kept.some((candidate) => candidate.id === repository.id)) {
            throw refuse('badMessage', `${repository.ref} is already added.`);
        }

        if (kept.length >= MAX_REPOSITORIES) {
            throw refuse('badMessage', `Up to ${MAX_REPOSITORIES} repositories can be added; remove one first.`);
        }

        // Asked once before it is kept, so a typo is said now rather than as an empty list later.
        const tried = await load(repository, true);

        if (tried.error) throw refuse(tried.error.indexOf('no published releases') !== -1 ? 'notFound' : 'downloadFailed', tried.error);

        if (!tried.entries.length) {
            throw refuse('notFound', repository.kind === 'github'
                ? `The newest release of ${repository.ref} has no .wgt or .tpk files.`
                : `${repository.ref} lists no apps this can install.`);
        }

        const stored = { ...repository, addedAt: new Date().toISOString() };

        config.update({ repositories: kept.concat(stored) });
        say.ok(`added ${repository.kind === 'github' ? 'the collection' : 'the catalog'} ${repository.ref} — ${tried.entries.length} apps`);

        return describe(stored, tried);
    };

    const remove = (id) => {
        const kept = repositories();
        const gone = kept.find((repository) => repository.id === id);

        if (!gone) throw refuse('notFound', 'No repository with that id.');

        config.update({ repositories: kept.filter((repository) => repository.id !== id) });
        delete status[id];

        // Its cached list goes with it.
        try { unlinkSync(cachePathOf(gone)); } catch (e) { /* never cached */ }

        say.info(`removed ${gone.ref}`);

        return gone;
    };

    const list = () => repositories().map((repository) => describe(repository, readCache(repository) && {
        entries: readCache(repository).entries, stale: false
    }));

    return { fetch, add, remove, list, repositories };
};

module.exports = { createLibrary, classify, OFFICIAL, MAX_REPOSITORIES, CACHE_TTL };
