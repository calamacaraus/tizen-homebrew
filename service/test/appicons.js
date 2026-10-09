'use strict';

const { mkdtempSync, readdirSync, writeFileSync, mkdirSync, existsSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const fixture = require('./fixture.js');
const manifest = require('../src/install/manifest.js');
const customize = require('../src/install/customize.js');
const { createAppIcons } = require('../src/install/appicons.js');
const { createLibrary } = require('../src/install/library.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const main = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'homebrew-appicons-'));
    const icons = createAppIcons({ dir, key: 'test-key' });
    const tokenOf = (packageId) => new URL(`http://x${icons.urlOf(packageId)}`).searchParams.get('t');

    {
        const archive = fixture.wgtWithIcon();
        const identity = manifest.identify(archive);

        check('an installed package\'s icon is kept for the phone',
            icons.fromArchive(archive, identity) && icons.has(identity.packageId) &&
            /^\/icons\/GJBBYNLkgP\.png\?v=\d+&t=[0-9a-f]{32}$/.test(icons.urlOf(identity.packageId)), icons.urlOf(identity.packageId));

        const read = icons.read('GJBBYNLkgP.png', tokenOf('GJBBYNLkgP'));
        check('and served back as what it is', read && read.type === 'image/png' && read.bytes.equals(fixture.PIXEL), JSON.stringify(read));

        check('but only to an address carrying its token, so no page can probe which apps are installed',
            icons.read('GJBBYNLkgP.png') === null && icons.read('GJBBYNLkgP.png', '0'.repeat(32)) === null, 'served');

        check('nothing outside the icons is served, by any name',
            icons.read('../config.json') === null && icons.read('GJBBYNLkgP.png/../../x') === null && icons.read('a.svg') === null,
            'served');

        const { archive: customised } = await customize.apply(archive, identity,
            { icon: { type: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]) } });

        icons.fromArchive(customised, manifest.identify(customised));

        check('a custom icon replaces the kept one, of another kind, with no copy of the old left',
            icons.has('GJBBYNLkgP').file === 'GJBBYNLkgP.jpg' && readdirSync(dir).join() === 'GJBBYNLkgP.jpg',
            readdirSync(dir).join());
    }

    {
        const apps = mkdtempSync(join(tmpdir(), 'homebrew-apps-'));
        writeFileSync(join(apps, 'icon.png'), fixture.PIXEL);

        check('an icon is read off the set only from where apps live there',
            icons.fromTv('aaaaaaaaaa', join(apps, 'icon.png')) === false && !icons.has('aaaaaaaaaa'), 'read from anywhere');

        check('and never through ..', icons.fromTv('bbbbbbbbbb', '/opt/usr/apps/../../etc/passwd') === false, 'followed');

        check('nor anything that is not a PNG or a JPEG', require('../src/install/appicons.js').kindOf(Buffer.from('<svg/>')) === null, 'accepted');
    }

    {
        writeFileSync(join(dir, 'gone000001.png'), fixture.PIXEL);

        check('an empty listing from a failed ask removes nothing', icons.prune([]) === 0 && readdirSync(dir).length === 2,
            readdirSync(dir).join());

        check('an app gone from the set takes its icon with it',
            icons.prune(['GJBBYNLkgP', 'other']) === 1 && readdirSync(dir).join() === 'GJBBYNLkgP.jpg', readdirSync(dir).join());
    }

    {
        const configDir = mkdtempSync(join(tmpdir(), 'homebrew-custom-'));
        mkdirSync(join(configDir, 'homebrewIcons'));
        writeFileSync(join(configDir, 'homebrewIcons', 'tUb3Xq7Lm9.png'), fixture.PIXEL);
        writeFileSync(join(configDir, 'homebrewIcons', 'tUb3Xq7Lm9.jpg'), fixture.PIXEL);

        const swept = customize.sweepIcons(configDir, { tUb3Xq7Lm9: { icon: { type: 'image/png', file: 'tUb3Xq7Lm9.png' } } });

        check('your own icons nothing points at any more are swept, the one in use kept',
            swept === 1 && readdirSync(join(configDir, 'homebrewIcons')).join() === 'tUb3Xq7Lm9.png',
            readdirSync(join(configDir, 'homebrewIcons')).join());
    }

    {
        const cacheDir = mkdtempSync(join(tmpdir(), 'homebrew-repos-'));
        let stored = { repositories: [] };
        const config = { read: () => stored, update: (patch) => { stored = { ...stored, ...patch }; return stored; } };
        const official = { fetch: () => Promise.resolve({ entries: [], stale: false, source: 'cache' }) };
        const release = { tag_name: 'v1', assets: [{ name: 'Alpha-Player.wgt', browser_download_url: 'https://x/Alpha-Player.wgt', digest: null }] };

        let current = release;
        const library = createLibrary({ config, official, cacheDir, latestRelease: () => Promise.resolve(current) });
        const added = await library.add('owner/collection');

        current = { tag_name: 'v2', assets: [{ name: 'Alpha-1.0.47.wgt', browser_download_url: 'https://x/Alpha-1.0.47.wgt', digest: null }] };

        const cached = await library.fetch();
        const pressedAtOnce = await library.fetch({ refresh: { repository: added.id } });

        const realNow = Date.now;
        Date.now = () => realNow() + 61 * 1000;
        const asked = await library.fetch({ refresh: { repository: added.id } });
        Date.now = realNow;

        check('checking one app of a collection asks that repository again, and only when asked',
            cached.entries[0].version !== '1.0.47' && asked.entries[0].version === '1.0.47',
            `${cached.entries[0].version} ${asked.entries[0].version}`);

        // The collection keeps its app and gains another.
        current = { tag_name: 'v3', assets: release.assets.concat([{ name: 'Doom.wgt', browser_download_url: 'https://x/Doom.wgt', digest: null }]) };
        Date.now = () => realNow() + 2 * 61 * 1000;
        const third = await library.fetch({ refresh: { repository: added.id } });
        Date.now = realNow;

        const doom = third.entries.find((entry) => entry.source.asset === 'Doom.wgt');
        const kept = third.entries.find((entry) => entry.source.asset === 'Alpha-Player.wgt');
        const row = third.repositories.find((repository) => repository.id === added.id);

        check('an app that turns up in a collection after it was added is marked new, and counted',
            doom && doom.isNew === true && row.newCount >= 1 && row.checkedAt, JSON.stringify({ doom: doom && doom.isNew, row }));

        check('while one there since the collection was added is not', kept && !kept.isNew,
            JSON.stringify(kept && { isNew: kept.isNew }));

        check('but pressed again within a minute, the answer just fetched stands',
            pressedAtOnce.entries[0].version !== '1.0.47', String(pressedAtOnce.entries[0].version));

        check('an added repository caches its list', existsSync(join(cacheDir, `homebrewRepo-${added.id}.json`)), readdirSync(cacheDir).join());

        library.remove(added.id);

        check('and removing it removes the cache too', !existsSync(join(cacheDir, `homebrewRepo-${added.id}.json`)), readdirSync(cacheDir).join());
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

main().catch((error) => {
    console.error('\nHarness error:', error.stack);
    process.exit(1);
});
