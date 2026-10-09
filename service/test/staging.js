'use strict';

// What an install leaves on the television, what it refuses to put near a shell, and the record of where
// each app came from.

const { mkdtempSync, readdirSync, statSync, writeFileSync, utimesSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const fixture = require('./fixture.js');
const manifest = require('../src/install/manifest.js');
const installer = require('../src/install/installer.js');
const { createInstaller } = require('../src/install/pipeline.js');
const { createUpdates } = require('../src/install/updates.js');
const { createStore } = require('../src/state.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const refusal = (fn) => {
    try {
        fn();
        return null;
    } catch (error) {
        return error.code;
    }
};

const widget = (application) => fixture.zip('config.xml', Buffer.from(
    `<?xml version="1.0"?><widget xmlns:tizen="http://tizen.org/ns/widgets" version="1.0.0">${application}<name>X</name></widget>`));

const fakeConfig = (initial = {}) => {
    let stored = { lastInstalled: [], author: 'present', ...initial };
    return {
        read: () => stored,
        update: (patch) => { stored = { ...stored, ...patch }; return stored; },
        hasCertificates: () => true,
        forgetCertificates: () => {}
    };
};

const fakeSdb = (output = 'coreinstall spend time = 1234 ms') => ({
    withSession: (_options, run) => run({ exec: () => Promise.resolve(output), close: () => {} })
});

const fakeDevice = { probe: () => Promise.resolve({ onTv: true, ready: true, needsResign: false }) };
const taken = (given) => (given && typeof given.take === 'function' ? given.take() : given);
const fakeResigner = () => Promise.resolve(async (given) => ({ archive: taken(given), device: 'TESTSET', files: 1 }));

const main = async () => {
    {
        check('a package id with a shell command in it is refused before anything installs it',
            refusal(() => manifest.identify(widget('<tizen:application id="abc.App" package="abc;reboot"/>'))) === 'badPackage',
            'accepted');

        check('as is one with a space or a quote',
            refusal(() => manifest.identify(widget('<tizen:application id="abc.App" package="abc def"/>'))) === 'badPackage' &&
            refusal(() => manifest.identify(widget('<tizen:application id="a$(id)" package="abcdefghij"/>'))) === 'badPackage',
            'accepted');

        check('while real ones — a widget\'s and a native reverse-domain one — still pass',
            manifest.identify(widget('<tizen:application id="tUb3Xq7Lm9.Tube" package="tUb3Xq7Lm9"/>')).packageId === 'tUb3Xq7Lm9' &&
            manifest.identify(fixture.zip('tizen-manifest.xml', Buffer.from(
                '<manifest package="org.example.echo" version="0.2.0"><ui-application appid="org.example.echo"/></manifest>')))
                .packageId === 'org.example.echo',
            'refused');
    }

    {
        const dir = mkdtempSync(join(tmpdir(), 'homebrew-staging-'));
        const archive = fixture.wgtWithIcon();

        const first = await installer.stage(archive, { isWgt: true }, dir);
        const second = await installer.stage(archive, { isWgt: true }, dir);

        check('each install is staged under a name of its own',
            first !== second && /homebrew-[0-9a-f]{16}\.wgt$/.test(first), `${first} ${second}`);

        check('and holds exactly what was signed', statSync(first).size === archive.length, String(statSync(first).size));

        check('and removed afterwards', installer.unstage(first) && !readdirSync(dir).some((name) => first.endsWith(name)),
            readdirSync(dir).join());

        // An old package.wgt from an earlier version, a fresh one the laptop just put there, and an orphan of ours.
        writeFileSync(join(dir, 'package.wgt'), 'old');
        const ago = (Date.now() - 60 * 60 * 1000) / 1000;
        utimesSync(join(dir, 'package.wgt'), ago, ago);
        writeFileSync(join(dir, 'package.tpk'), 'fresh');
        writeFileSync(join(dir, 'notes.txt'), 'someone else');

        const orphan = join(dir, 'homebrew-00112233445566ff.wgt');
        writeFileSync(orphan, 'mid-install');

        check('between installs, a staged file still young enough to be in use is left',
            installer.sweep(dir, { everything: false }) === 1 && readdirSync(dir).indexOf('homebrew-00112233445566ff.wgt') !== -1,
            readdirSync(dir).join());

        const swept = installer.sweep(dir);
        const left = readdirSync(dir).sort().join();

        check('a restart sweeps up what an interrupted install left, and the old package.wgt',
            swept === 2 && left === 'notes.txt,package.tpk', `${swept} swept, left ${left}`);

        check('and a file read back from disk hashes as what was written',
            await installer.digestOfFile(join(dir, 'notes.txt')) === require('crypto').createHash('sha256').update('someone else').digest('hex'),
            'different');
    }

    {
        // The staged copy goes whatever the install's outcome.
        const realStage = installer.stage;
        const realUnstage = installer.unstage;
        const removed = [];

        installer.stage = () => '/tmp/homebrew-0123456789abcdef.wgt';
        installer.unstage = (path) => { removed.push(path); return true; };

        const config = fakeConfig();
        const store = createStore({
            installing: false,
            catalog: [{ id: 'gh-x.alpha', name: 'Alpha', repository: 'gh-x', collection: true,
                source: { type: 'url', ref: 'https://example.invalid/Alpha.wgt' } }]
        });

        const ok = createInstaller({ sdb: fakeSdb(), device: fakeDevice, config, resigner: fakeResigner, store });
        await ok.install({ source: 'upload', reference: 'homebrew.wgt', upload: fixture.wgtWithIcon() });

        check('a finished install removes its staged copy', removed.length === 1, JSON.stringify(removed));

        const origin = config.read().origins.GJBBYNLkgP;

        check('and records where it came from, for the phone to show',
            origin && origin.source === 'upload' && origin.file === 'homebrew.wgt' && origin.version && origin.sha256 && origin.at,
            JSON.stringify(origin));

        const failing = createInstaller({ sdb: fakeSdb('install failed [118] signature error'), device: fakeDevice,
            config, resigner: fakeResigner, store });

        await failing.install({ source: 'upload', reference: 'homebrew.wgt', upload: fixture.wgtWithIcon() }).catch(() => null);

        check('and so does one the TV refused', removed.length === 2, JSON.stringify(removed));

        const dropped = createInstaller({ sdb: { withSession: () => Promise.reject(Object.assign(new Error('reset'), { code: 'sdbReset' })) },
            device: fakeDevice, config, resigner: fakeResigner, store });

        await dropped.install({ source: 'upload', reference: 'homebrew.wgt', upload: fixture.wgtWithIcon() }).catch(() => null);

        check('but one whose session dropped is left for the TV, which may still be installing it',
            removed.length === 2, JSON.stringify(removed));

        installer.stage = realStage;
        installer.unstage = realUnstage;

        // An app installed from an upload, which no list names, still shows as installed, with its origin.
        const packages = { list: () => Promise.resolve([{ id: 'GJBBYNLkgP', version: '0.3.4' }, { id: 'tUb3Xq7Lm9', version: '1.4.0' }]) };
        const updates = createUpdates({ config, packages, latestRelease: () => Promise.reject(new Error('offline')) });

        const youtube = { id: 'youtube', name: 'YouTube', packageId: 'tUb3Xq7Lm9', repository: 'official',
            source: { type: 'github', ref: 'SushyDev/tizen-youtube' } };

        const others = await updates.others([youtube]);
        const marked = await updates.mark([youtube]);

        check('an installed app no list names is listed with where it came from',
            others.length === 1 && others[0].packageId === 'GJBBYNLkgP' && others[0].origin.source === 'upload' && others[0].unlisted,
            JSON.stringify(others));

        check('and a listed app installed before records were kept says so with no origin',
            marked[0].installed === '1.4.0' && marked[0].origin === null, JSON.stringify(marked[0]));

        const later = createUpdates({ config, latestRelease: () => Promise.reject(new Error('offline')),
            packages: { list: () => Promise.resolve([{ id: 'GJBBYNLkgP', version: '9.9.9' }]) } });
        const [moved] = await later.others([]);

        check('an app since changed outside Homebrew is not shown with the old file and checksum',
            moved.origin.replaced === true && moved.origin.verified === false, JSON.stringify(moved.origin));
    }

    {
        const config = fakeConfig({ installedFrom: { 'gh-x.alpha': { packageId: 'AlphaApp01', at: '2026-10-07T18:00:00Z' } } });
        const packages = { list: () => Promise.resolve([{ id: 'AlphaApp01', version: '1.0.46' }]) };
        const updates = createUpdates({ config, packages, latestRelease: () => Promise.reject(new Error('offline')) });

        const [alpha] = await updates.mark([{ id: 'gh-x.alpha', name: 'Alpha', repository: 'gh-x', collection: true,
            source: { type: 'github', ref: 'x/y', asset: 'Alpha-Player.wgt', exact: true } }]);

        check('an app an earlier 0.3 installed shows the list it came from, from the record that version kept',
            alpha.origin && alpha.origin.repository === 'gh-x' && alpha.origin.asset === 'Alpha-Player.wgt',
            JSON.stringify(alpha.origin));
    }

    {
        // A repository's package that turns out to be an app already on the TV, from elsewhere.
        const realStage = installer.stage;
        const realUnstage = installer.unstage;
        installer.stage = () => '/tmp/homebrew-0123456789abcdee.wgt';
        installer.unstage = () => true;

        const youtube = fixture.zip('config.xml', Buffer.from('<?xml version="1.0"?><widget xmlns:tizen="http://tizen.org/ns/widgets" ' +
            'version="9.9.9"><tizen:application id="tUb3Xq7Lm9.Tube" package="tUb3Xq7Lm9"/><name>Not YouTube</name></widget>'));
        const sources = require('../src/install/sources.js');
        const realResolve = sources.resolve;

        const store = createStore({ installing: false, catalog: [
            { id: 'cat-evil.free', name: 'Free app', repository: 'cat-evil', source: { type: 'url', ref: 'https://evil.example/free.wgt' } }
        ] });
        const config = fakeConfig({ origins: { tUb3Xq7Lm9: { source: 'catalog', repository: 'official' } } });

        const make = (archive) => {
            sources.resolve = async () => ({ archive, name: 'free.wgt', expected: null, origin: { type: 'url', url: 'https://evil.example/free.wgt' } });
            return createInstaller({ sdb: fakeSdb(), device: fakeDevice, config, resigner: fakeResigner, store,
                isInstalled: async (id) => id === 'tUb3Xq7Lm9' || id === 'GJBBYNLkgP' });
        };

        const refused = await make(youtube).install({ source: 'catalog', reference: 'cat-evil.free' }).catch((error) => error);

        check('a repository\'s app that is really another installed app is stopped, and can be confirmed',
            refused.code === 'replacesOther' && refused.confirmable === true && /Tizen Homebrew list/.test(refused.message),
            refused.message);

        const blank = await make(youtube).install({ source: 'catalog', reference: 'cat-evil.free', confirm: true }).catch((error) => error);
        const other = await make(youtube).install({ source: 'catalog', reference: 'cat-evil.free', confirm: true, expect: 'AlphaApp01' })
            .catch((error) => error);

        check('a confirmation counts only for the package it was about',
            blank.code === 'replacesOther' && other.code === 'packageMismatch', `${blank.code} ${other.code}`);

        const confirmed = await make(youtube).install({ source: 'catalog', reference: 'cat-evil.free', confirm: true, expect: 'tUb3Xq7Lm9' })
            .catch((error) => error);

        check('and installs once you confirm it', !confirmed.code && confirmed.packageId === 'tUb3Xq7Lm9', JSON.stringify(confirmed));

        const again = await make(youtube).install({ source: 'catalog', reference: 'cat-evil.free' }).catch((error) => error);
        check('and once replaced from that repository, its next update from there is not asked about again',
            !again.code, again.message);

        const self = await make(fixture.wgtWithIcon()).install({ source: 'catalog', reference: 'cat-evil.free', confirm: true })
            .catch((error) => error);

        check('but a repository never replaces Tizen Homebrew itself, confirmed or not',
            self.code === 'replacesOther' && !self.confirmable, self.message);

        const mismatch = await make(youtube).install({ source: 'catalog', reference: 'cat-evil.free', expect: 'AlphaApp01' })
            .catch((error) => error);

        check('an unattended update that downloads a different package than before is refused',
            mismatch.code === 'packageMismatch', mismatch.message);

        // A catalog entry naming the same file as the built-in list does not get recorded for its install.
        const recordStore = createStore({ installing: false, catalog: [
            { id: 'youtube', name: 'YouTube', repository: 'official', packageId: 'tUb3Xq7Lm9', source: { type: 'url', ref: 'https://evil.example/free.wgt' } },
            { id: 'cat-evil.same', name: 'Same', repository: 'cat-evil', source: { type: 'url', ref: 'https://evil.example/free.wgt' } }
        ] });
        const recordConfig = fakeConfig();
        sources.resolve = async () => ({ archive: youtube, name: 'free.wgt', expected: null, origin: { type: 'url', url: 'https://evil.example/free.wgt' } });
        await createInstaller({ sdb: fakeSdb(), device: fakeDevice, config: recordConfig, resigner: fakeResigner, store: recordStore,
            isInstalled: async () => false }).install({ source: 'catalog', reference: 'youtube' });

        const recorded = Object.keys(recordConfig.read().installedFrom || {});
        check('an added catalog that names the same file as another list does not get credit for its install',
            recorded.indexOf('youtube') !== -1 && recorded.indexOf('cat-evil.same') === -1, recorded.join());

        sources.resolve = realResolve;
        installer.stage = realStage;
        installer.unstage = realUnstage;
    }

    {
        const { createLibrary } = require('../src/install/library.js');
        let stored = { repositories: [] };
        const config = { read: () => stored, update: (patch) => { stored = { ...stored, ...patch }; return stored; } };
        const official = { fetch: () => Promise.resolve({ entries: [], stale: false, source: 'cache' }) };
        const library = createLibrary({ config, official, cacheDir: mkdtempSync(join(tmpdir(), 'homebrew-cat-')),
            fetchJson: async () => ({ apps: [{ id: 'free', name: 'Free', packageId: 'GJBBYNLkgP',
                source: { type: 'url', ref: 'https://evil.example/free.wgt' } }] }) });

        await library.add('https://evil.example/catalog.json');
        const { entries } = await library.fetch();

        check('a package id an added catalog claims is not believed', entries.length === 1 && entries[0].packageId === null,
            JSON.stringify(entries));
    }

    {
        // A package for a newer Tizen than the TV, refused before anything is signed.
        const tube = fixture.zip('config.xml', Buffer.from('<?xml version="1.0"?><widget xmlns:tizen="http://tizen.org/ns/widgets" ' +
            'version="1.4.0"><tizen:application id="tUb3Xq7Lm9.Tube" package="tUb3Xq7Lm9" required_version="5.5"/><name>YouTube</name></widget>'));
        let signed = false;
        const old = createInstaller({ sdb: fakeSdb(), config: fakeConfig(), store: createStore({ installing: false, catalog: [] }),
            device: { probe: () => Promise.resolve({ onTv: true, ready: true, platformVersion: '3.0' }) },
            resigner: () => { signed = true; return fakeResigner(); } });

        const refused = await old.install({ source: 'upload', reference: 'tube.wgt', upload: tube }).catch((error) => error);

        check('an app that needs a newer Tizen than the TV is refused, saying which, and never signed',
            refused.code === 'needsNewerTizen' && /Tizen 5\.5/.test(refused.message) && /Tizen 3\.0/.test(refused.message) && !signed,
            refused.message);
    }

    {
        const protocol = require('../src/protocol.js');
        const codeOf = (raw) => { try { protocol.parse(raw); return 'ok'; } catch (e) { return e.code; } };

        check('a message whose payload is not an object is a bad message, not an internal error',
            ['-1', '"text"', '[1]', 'true'].every((value) => codeOf(`{"type":"checkUpdates","payload":${value}}`) === 'badMessage'),
            ['-1', '"text"', '[1]', 'true'].map((value) => codeOf(`{"type":"checkUpdates","payload":${value}}`)).join());

        // An answer sent before the body was read closes the connection.
        const http = require('http');
        const { createRouter } = require('../src/http/router.js');
        const router = createRouter({});
        router.on.post('/refuse', (request, response) => { response.writeHead(403); response.end(); });

        const server = http.createServer(router.listener);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;

        const refused = await new Promise((resolve) => {
            const r = http.request({ port, path: '/refuse', method: 'POST', headers: { 'content-length': 100000 }, agent: false },
                (response) => { response.resume(); resolve(response.headers.connection); });
            r.on('error', () => resolve('error'));
            r.write(Buffer.alloc(10));
        });

        check('an answer given before the body was read closes the connection', refused === 'close', String(refused));

        server.close();
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

main().catch((error) => {
    console.error('\nHarness error:', error.stack);
    process.exit(1);
});
