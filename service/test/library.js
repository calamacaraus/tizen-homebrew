'use strict';

const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

process.env.HOMEBREW_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'homebrew-library-'));

const config = require('../src/config.js');
const protocol = require('../src/protocol.js');
const collection = require('../src/install/collection.js');
const { createLibrary, classify } = require('../src/install/library.js');
const { createUpdates } = require('../src/install/updates.js');
const { createAutoUpdate } = require('../src/install/autoupdate.js');
const { createStore } = require('../src/state.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const HEX = (letter) => new Array(65).join(letter);

const COMMUNITY = {
    tag_name: 'community-550',
    published_at: '2026-10-07T05:32:00Z',
    assets: [
        { name: 'Alpha-1.0.46.wgt', size: 1400000, digest: `sha256:${HEX('a')}`, browser_download_url: 'https://example.invalid/a' },
        { name: 'Bravo.wgt', size: 8100000, digest: `sha256:${HEX('b')}`, browser_download_url: 'https://example.invalid/b' },
        { name: 'Delta.tpk', size: 21700000, browser_download_url: 'https://example.invalid/c' },
        { name: 'checksums.txt', size: 900, browser_download_url: 'https://example.invalid/d' }
    ]
};

const OFFICIAL = [
    { id: 'homebrew', name: 'Tizen Homebrew', packageId: 'GJBBYNLkgP', version: null,
        source: { type: 'github', ref: 'SushyDev/tizen-homebrew' } }
];

const officialCatalog = (entries = OFFICIAL, failing = false) => ({
    fetch: async () => {
        if (failing) throw Object.assign(new Error('offline'), { code: 'downloadFailed' });
        return { entries, stale: false, source: 'network' };
    }
});

const main = async () => {
    {
        const entries = collection.expand({ id: 'gh-community', ref: 'example/tv-packages' }, COMMUNITY);

        check('a collection lists every package file in its release, and nothing else',
            entries.length === 3 && entries.every((entry) => /\.(wgt|tpk)$/.test(entry.source.asset)),
            JSON.stringify(entries.map((entry) => entry.source.asset)));

        const alpha = entries.find((entry) => entry.source.asset === 'Alpha-1.0.46.wgt');

        check('the version in a file name is read, and left out of the entry id',
            alpha && alpha.version === '1.0.46' && alpha.id === 'gh-community.alpha' && alpha.name === 'Alpha',
            JSON.stringify(alpha));

        check('the release digest becomes the entry sha256, and a file with none has none',
            alpha.sha256 === HEX('a') && entries.find((entry) => entry.source.asset === 'Delta.tpk').sha256 === null,
            JSON.stringify(entries.map((entry) => entry.sha256)));

        check('a collection entry asks for its file by exact name',
            alpha.source.exact === true && alpha.source.type === 'github', JSON.stringify(alpha.source));

        const next = collection.expand({ id: 'gh-community', ref: 'x/y' }, {
            assets: [{ name: 'Alpha-1.0.47.wgt', digest: `sha256:${HEX('c')}` }]
        });

        check('so the next release of the same app is the same entry', next[0].id === alpha.id, next[0].id);
    }

    {
        const github = classify('https://github.com/example/tv-packages/');
        const plain = classify('example/tv-packages');
        const catalog = classify('https://example.com/apps/catalog.json');

        check('a pasted github.com link and a typed owner/repo are the same collection',
            github.kind === 'github' && github.ref === 'example/tv-packages' && github.id === plain.id,
            JSON.stringify([github, plain]));

        check('an https link elsewhere is a catalog', catalog.kind === 'catalog' && /^cat-/.test(catalog.id),
            JSON.stringify(catalog));

        const refusals = ['http://example.com/catalog.json', 'not a repo', 'a/b/c d', ''].map((typed) => {
            try {
                classify(typed);
                return null;
            } catch (error) {
                return error.code;
            }
        });

        check('a plain-http catalog, and anything that is neither, is refused',
            refusals.every((code) => code === 'badMessage'), JSON.stringify(refusals));
    }

    {
        config.clear();

        let asked = 0;
        const library = createLibrary({
            config,
            official: officialCatalog(),
            cacheDir: process.env.HOMEBREW_CONFIG_DIR,
            latestRelease: async (ref) => {
                asked += 1;
                if (ref === 'nobody/empty') return { tag_name: 'v1', assets: [{ name: 'notes.txt' }] };
                if (ref === 'nobody/missing') throw Object.assign(new Error('nobody/missing has no published releases, or is private.'), { code: 'notFound' });
                return COMMUNITY;
            }
        });

        const added = await library.add('example/tv-packages');

        check('adding a collection asks it once and says how many apps it holds',
            added.count === 3 && asked === 1 && config.read().repositories.length === 1, JSON.stringify(added));

        const twice = await library.add('example/tv-packages').then(() => null, (error) => error.message);

        check('and the same one cannot be added twice', /already added/.test(twice || ''), twice);

        const empty = await library.add('nobody/empty').then(() => null, (error) => error.code);
        const missing = await library.add('nobody/missing').then(() => null, (error) => error.code);

        check('a repository with no packages, or none at all, is refused before it is kept',
            empty === 'notFound' && missing === 'notFound' && config.read().repositories.length === 1,
            `${empty} / ${missing} / ${config.read().repositories.length}`);

        asked = 0;
        const listed = await library.fetch({});

        check('the merged list is the built-in catalog followed by the collection',
            listed.entries.length === 4 && listed.entries[0].repository === 'official' &&
            listed.entries.slice(1).every((entry) => entry.repository === added.id),
            JSON.stringify(listed.entries.map((entry) => entry.id)));

        check('and within six hours a collection is read from its cache, not GitHub', asked === 0, `${asked} requests`);

        await library.fetch({ refresh: 'collections' });

        check('while a check for updates asks each collection again', asked === 1, `${asked} requests`);

        check('every repository is reported, the built-in one first',
            listed.repositories.length === 2 && listed.repositories[0].builtIn && listed.repositories[1].count === 3,
            JSON.stringify(listed.repositories));

        library.remove(added.id);

        const after = await library.fetch({});

        check('a removed repository takes its apps with it',
            after.entries.length === 1 && config.read().repositories.length === 0, JSON.stringify(after.entries.map((e) => e.id)));
    }

    {
        config.clear();

        const library = createLibrary({
            config,
            official: officialCatalog(OFFICIAL, true),
            cacheDir: mkdtempSync(join(tmpdir(), 'homebrew-library-cache-')),
            latestRelease: async () => COMMUNITY
        });

        const lonely = await library.fetch({}).then(() => null, (error) => error.code);

        check('with no repositories, a dead origin is still the failure it was', lonely === 'downloadFailed', String(lonely));

        const told = await library.fetch({ keepGoing: true });
        const builtIn = told.repositories.find((repository) => repository.builtIn);

        check('but a phone is answered with the empty list and why, so the list\'s own row can say it',
            told.entries.length === 0 && builtIn && builtIn.count === 0 && /offline/.test(builtIn.error || ''),
            JSON.stringify(builtIn));

        await library.add('example/tv-packages');
        const partial = await library.fetch({});

        check('with one, the collection still lists while the origin is down',
            partial.entries.length === 3 && partial.repositories[0].error === 'offline', JSON.stringify(partial.repositories[0]));
    }

    {
        const entries = collection.expand({ id: 'gh-community', ref: 'x/y' }, COMMUNITY);
        const bravo = entries.find((entry) => entry.source.asset === 'Bravo.wgt');
        const alpha = entries.find((entry) => entry.source.asset === 'Alpha-1.0.46.wgt');

        config.clear();
        config.update({
            installedFrom: {
                [bravo.id]: { packageId: 'BravoTVapp', version: '0.16.72', sha256: HEX('f') },
                [alpha.id]: { packageId: 'AlphaApp01', version: '1.0.46', sha256: HEX('f') }
            }
        });

        const updates = createUpdates({
            config,
            packages: { list: async () => [{ id: 'BravoTVapp', version: '0.16.72' }, { id: 'AlphaApp01', version: '1.0.46' }] }
        });

        const marked = await updates.mark(entries);
        const markedBravo = marked.find((entry) => entry.id === bravo.id);
        const markedAlpha = marked.find((entry) => entry.id === alpha.id);

        check('a collection entry knows what it installed, by the package id it learned',
            markedBravo.installed === '0.16.72' && markedBravo.packageId === 'BravoTVapp', JSON.stringify(markedBravo));

        check('with no version to compare, a different sha256 is an update',
            markedBravo.update === true && markedBravo.rebuilt === false, JSON.stringify(markedBravo));

        check('at the same version, a different sha256 is a rebuild, offered but not an update',
            markedAlpha.update === false && markedAlpha.rebuilt === true, JSON.stringify(markedAlpha));

        config.update({
            installedFrom: { [bravo.id]: { packageId: 'BravoTVapp', version: '0.16.72', sha256: HEX('b') } }
        });

        const same = (await updates.mark(entries)).find((entry) => entry.id === bravo.id);

        check('and the file that is installed is neither', same.update === false && same.rebuilt === false, JSON.stringify(same));

        // A file name that says 1.0.46 around a config.xml that says 1.0.0: installed once, then left alone.
        config.update({
            installedFrom: { [alpha.id]: { packageId: 'AlphaApp01', version: '1.0.0', sha256: HEX('a') } }
        });

        const stubborn = createUpdates({ config, packages: { list: async () => [{ id: 'AlphaApp01', version: '1.0.0' }] } });
        const held = (await stubborn.mark(entries)).find((entry) => entry.id === alpha.id);

        check('the very file installed is not its own update, whatever its name claims',
            held.update === false, JSON.stringify(held));
    }

    {
        const ids = collection.expand({ id: 'r', ref: 'a/b' }, {
            assets: [{ name: 'App-1.0.wgt' }, { name: 'App-2.0.wgt' }, { name: 'App.wgt' },
                { name: 'tube-1.1.0-tizen-5.5.wgt' }, { name: 'tube-1.1.0-tizen-5.0.wgt' }]
        }).map((entry) => entry.id);

        check('files that read as the same app still get ids of their own',
            new Set(ids).size === ids.length, JSON.stringify(ids));

        const next = collection.expand({ id: 'r', ref: 'a/b' }, { assets: [{ name: 'tube-1.2.0-tizen-5.5.wgt' }] });

        check('and a platform-specific build keeps its id across releases',
            next[0].id === ids[3] && next[0].version === '1.2.0', JSON.stringify([ids[3], next[0]]));
    }

    {
        config.clear();

        const store = createStore({ installing: false, catalog: [] });
        const installed = [];
        const heard = [];

        const marked = [
            { id: 'homebrew', name: 'Tizen Homebrew', packageId: 'GJBBYNLkgP', update: true },
            { id: 'a', name: 'Alpha', packageId: 'AlphaApp01', update: true },
            { id: 'b', name: 'Bravo', packageId: 'BravoTVapp', update: false, rebuilt: true },
            { id: 'c', name: 'Echo', packageId: 'EchoTiZen0', update: false }
        ];

        const fast = { setTimeout: (fn) => setTimeout(fn, 5), setInterval, clearTimeout, clearInterval };

        const auto = createAutoUpdate({
            timers: fast,
            library: { fetch: async () => ({ entries: marked, stale: false }) },
            updates: { check: async () => marked, changed: () => {} },
            installer: {
                install: async ({ reference }) => {
                    installed.push(reference);
                    if (reference === 'a') throw Object.assign(new Error('Author certificate not match'), { code: 'authorMismatch' });
                }
            },
            config,
            store,
            broadcast: (type, payload) => heard.push(payload)
        });

        const result = await auto.run({});

        check('update all installs what has an update, and itself last',
            JSON.stringify(installed) === JSON.stringify(['a', 'homebrew']), JSON.stringify(installed));

        check('one that fails is reported and the rest still run',
            JSON.stringify(result.updated) === JSON.stringify(['Tizen Homebrew']) &&
            JSON.stringify(result.failed) === JSON.stringify(['Alpha']), JSON.stringify(result));

        check('and every screen hears how far it got, ending not running',
            heard.length >= 3 && heard[heard.length - 1].running === false, JSON.stringify(heard.map((h) => h.running)));

        installed.length = 0;
        await auto.run({ includeRebuilt: true });

        check('rebuilds are installed only when asked for', installed.indexOf('b') !== -1, JSON.stringify(installed));

        installed.length = 0;
        store.update({ installing: true });
        setTimeout(() => store.update({ installing: false }), 60);

        const waited = await auto.run({});

        check('a run that meets an install already going waits for it, rather than failing every app',
            installed.length === 2 && waited.failed.length === 1, JSON.stringify([installed, waited]));

        const doubled = [
            { id: 'official-tube', name: 'YouTube', packageId: 'tUb3Xq7Lm9', update: true, available: '1.4.0' },
            { id: 'coll.tube', name: 'YouTube', packageId: 'tUb3Xq7Lm9', update: true, available: '1.3.0', collection: true }
        ];
        const twice = [];
        const once = createAutoUpdate({
            timers: fast,
            library: { fetch: async () => ({ entries: doubled, stale: false }) },
            updates: { check: async () => doubled, changed: () => {} },
            installer: { install: async ({ reference }) => { twice.push(reference); } },
            config,
            store
        });

        await once.run({});

        check('one app listed twice is installed once, from the newer listing',
            JSON.stringify(twice) === JSON.stringify(['official-tube']), JSON.stringify(twice));

        installed.length = 0;
        config.update({ autoUpdate: 'check' });
        auto.tick();
        await new Promise((resolve) => setTimeout(resolve, 20));

        check('on schedule with "check", nothing is installed but the finding is kept',
            installed.length === 0 && config.read().lastUpdateResult.available.length === 2,
            JSON.stringify([installed, config.read().lastUpdateResult]));

        config.update({ autoUpdate: 'off' });
        auto.tick();
        await new Promise((resolve) => setTimeout(resolve, 20));

        check('and with "off" the schedule does nothing', installed.length === 0, JSON.stringify(installed));
    }

    {
        const parse = (payload, type = 'install') => {
            try {
                return protocol.parse(JSON.stringify({ type, payload })) && 'ok';
            } catch (error) {
                return error.code;
            }
        };

        check('an install may name one exact release file',
            parse({ source: 'github', ref: 'a/b', asset: 'Alpha-1.0.46.wgt' }) === 'ok', 'refused');

        check('but only a GitHub install, and only as a short string',
            parse({ source: 'url', ref: 'https://x/y.wgt', asset: 'y.wgt' }) === 'badMessage' &&
            parse({ source: 'github', ref: 'a/b', asset: 42 }) === 'badMessage' &&
            parse({ source: 'github', ref: new Array(600).join('x') }) === 'badMessage', 'accepted');

        check('a setting is one of the known values',
            parse({ autoUpdate: 'install' }, 'setSettings') === 'ok' && parse({ autoUpdate: 'always' }, 'setSettings') === 'badMessage',
            'wrong verdict');

        check('repositories are added by a ref and removed by an id',
            parse({ ref: 'a/b' }, 'addRepository') === 'ok' && parse({}, 'addRepository') === 'badMessage' &&
            parse({}, 'removeRepository') === 'badMessage', 'wrong verdict');
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

main().catch((error) => {
    console.error('\nHarness error:', error.stack);
    process.exit(1);
});
