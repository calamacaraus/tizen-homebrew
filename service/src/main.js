'use strict';

const { createServer } = require('http');
const { existsSync } = require('fs');
const { join, extname, normalize, sep } = require('path');
const { homedir } = require('os');

const { startRecording, Facility } = require('./obs/log.js');
const { size, took, host } = require('./obs/units.js');
const runtime = require('./obs/runtime.js');
const platform = require('./obs/platform.js');
const memory = require('./obs/memory.js');

const recorded = startRecording();
const log = recorded.log;

const { createStore } = require('./state.js');
const { createRouter } = require('./http/router.js');
const { json, failure, readBody } = require('./http/respond.js');
const pin = require('./auth/pin.js');
const { createAccess } = require('./http/access.js');
const { createIdle } = require('./idle.js');
const device = require('./tv/device.js');
const sdb = require('./tv/sdb.js');
const packages = require('./tv/packages.js');
const { Relay } = require('./tv/relay.js');
const config = require('./config.js');
const protocol = require('./protocol.js');
const { createInstaller } = require('./install/pipeline.js');
const { createCatalog } = require('./install/catalog.js');
const { createUpdates } = require('./install/updates.js');
const { createLibrary } = require('./install/library.js');
const { createAutoUpdate } = require('./install/autoupdate.js');
const { createAppIcons } = require('./install/appicons.js');

const { ErrorCode } = protocol;

// 8080 is taken by a Samsung system service, so binding there fails with EADDRINUSE.
const PORT = Number(process.env.HOMEBREW_PORT) || 8091;

const BUILD = '__HOMEBREW_BUILD__';
const ORIGIN = '__HOMEBREW_ORIGIN__';

const DEVELOPER = globalThis.__HOMEBREW_DEV__ === true;

// onRequest is exported before start() has made the access gate; it reaches it through this.
const launchedHook = { run: () => {} };

const start = () => {
    // Tizen can load the service into a process it already runs: a second start would add a second set of
    // timers and a second server, so the first one's answer is given again.
    if (process.__homebrewStarted) return process.__homebrewStarted;

    const startedAt = new Date().toISOString();
    const secret = DEVELOPER ? pin.DEVELOPER_PIN : config.pairingPin();

    const svc = log.on(Facility.SVC);
    const net = log.on(Facility.NET);
    const dev = log.on(Facility.DEV);

    svc.info(`tizen homebrew ${BUILD} starting`);
    svc.info(`${runtime.summary()}, pid ${process.pid}`);

    platform.describe().then(
        (facts) => platform.summary(facts).forEach((line) => dev.info(line)),
        (error) => dev.warn(`could not read the platform: ${error.message}`)
    );

    if (DEVELOPER) {
        log.on(Facility.AUTH).warn(`DEVELOPER BUILD — pin fixed at ${secret}, and POST /dev/eval will run ` +
            'anything this network sends it. Do not leave this on a television you care about.');
    } else {
        // Not the code itself: the log is read by every paired phone, and the TV screen shows the code.
        log.on(Facility.AUTH).info('pairing pin ready, shown on the TV screen — kept across restarts, so a reboot ' +
            'does not unpair every phone');
    }

    const adopted = config.adoptHandoff();

    if (adopted) {
        log.on(Facility.CFG).ok(`certificates adopted from bootstrap for ${adopted.join(', ') || 'an unnamed device'}`);
    } else if (config.hasLegacyCertificates()) {
        log.on(Facility.CFG).warn('the stored certificates are in the old .p12 format and cannot be used — ' +
            'run `npm run certs` again');
    }

    const store = createStore({
        installing: false,
        catalog: [],
        catalogStale: false,
        device: null,
        updateRun: null
    });

    const stored = config.read().catalogUrl;
    const catalogUrl = stored || `${ORIGIN}/catalog.json`;
    const catalogCache = join(homedir(), 'share', 'homebrewCatalog.json');

    const catalog = createCatalog({ url: catalogUrl, cachePath: catalogCache, log });

    // The built-in catalog plus every repository added on the phone, as one list.
    const library = createLibrary({ config, official: catalog, cacheDir: join(homedir(), 'share'), log });

    // No prime() at startup: priming getPackagesInfo wedges the service on Tizen 9.0.
    // Every installed app's icon, for the phone's list.
    if (!config.read().iconKey) config.update({ iconKey: require('crypto').randomBytes(16).toString('hex') });

    const appIconsDir = join(config.CONFIG_DIR, 'homebrewAppIcons');

    // Icons kept before 0.3.9 could be a background service's default icon rather than the app's: forgotten
    // once, and learned again from the TV or the next install.
    if (config.read().appIconsVersion !== 2) {
        try {
            require('fs').readdirSync(appIconsDir).forEach((name) => require('fs').unlinkSync(join(appIconsDir, name)));
        } catch (e) { /* none */ }
        config.update({ appIconsVersion: 2 });
    }

    const appIcons = createAppIcons({ dir: appIconsDir, log, key: config.read().iconKey });

    const updates = createUpdates({ packages, log, config, appIcons });

    log.on(Facility.CAT).info(`origin ${catalogUrl}${stored ? ' (from the stored configuration)' : ''}`);
    log.on(Facility.CFG).info(`cache ${catalogCache}`);

    const relay = new Relay({
        enabled: config.read().relayEnabled,
        packageId: device.onTv ? tizen.application.getAppInfo().packageId : null,
        log: (message) => log.on(Facility.RELAY).info(message)
    });

    if (relay.enabled) log.on(Facility.RELAY).warn('the command relay is ON from stored configuration');

    // Loaded on first use so a television that never installs anything does not parse the signer.
    const resigner = async () => {
        const { resign } = require('./install/resign.js');

        return (given, options) => resign(given, config.read(), options);
    };

    const installer = createInstaller({ sdb, device, config, resigner, store, log, appIcons,
        isInstalled: (packageId) => updates.isInstalled(packageId) });

    // Filled in once the socket server is up, at the end of this function. The device sweep and the
    // auto-updater are the only things that learn something without being asked, so they push.
    let sockets = null;

    const autoUpdate = createAutoUpdate({
        library, updates, installer, config, store, log,
        broadcast: (type, payload) => { if (sockets) sockets.broadcastPaired(type, payload); }
    });

    if (device.onTv) {
        require('./install/customize.js').sweepIcons(config.CONFIG_DIR, config.read().customizations);

        const swept = require('./install/installer.js').sweep();
        if (swept) log.on(Facility.PKG).info(`removed ${swept} staged ${swept === 1 ? 'package' : 'packages'} an earlier install left behind`);

        autoUpdate.start();
    }

    const announce = (state, previous) => {
        if (!previous) {
            dev.info(state.onTv
                ? `tizen ${state.platformVersion || 'unknown'}` +
                  `${state.needsResign ? ' — packages must be re-signed for this firmware' : ''}`
                : 'not running on a television — this is a development harness');

            if (state.onTv && state.developerMode === false) dev.warn('developer mode is off');
        } else if (previous.ready === state.ready) {
            return state;
        }

        if (state.ready) {
            log.on(Facility.SDB).ok(`loopback 127.0.0.1:${sdb.SDB_PORT} answered — this TV can install its own apps`);
        } else if (state.onTv) {
            log.on(Facility.SDB).warn(state.sdbDetail
                ? `loopback 127.0.0.1:${sdb.SDB_PORT} — ${state.sdbDetail}`
                : `loopback 127.0.0.1:${sdb.SDB_PORT} is not usable (${state.sdbError || state.reason || 'unknown'})`);

            dev.info(state.reason === 'debugModeOff'
                ? 'if it stays this way: Developer Mode in Apps › 12345 › Settings, then restart the TV'
                : 'if it stays this way: Host PC IP = 127.0.0.1 in Apps › 12345 › Settings, then restart ' +
                  'the TV — sdbd reads that value only at startup');
        }

        return state;
    };

    // Filled in once the socket server is up, at the end of this function; declared up there, beside
    // the auto-updater that also pushes through it.

    const refreshDevice = async () => {
        // An install has the connection; probing across it would only add commands to what sdbd is doing.
        if (store.select('installing')) return store.select('device');

        const previous = store.select('device');
        const first = await device.probe();

        // sdbd drops the occasional connection, so a demotion is confirmed by a second probe.
        const state = previous && previous.ready && !first.ready
            ? await device.probe()
            : first;

        store.update({ device: state });

        // Compared whole: `ready` alone would hold back a changed reason for the same unreadiness.
        if (sockets && JSON.stringify(previous) !== JSON.stringify(state)) {
            sockets.broadcast(protocol.Outbound.STATE, { ...state, hasCertificates: config.hasCertificates() });
        }

        return announce(state, previous);
    };

    refreshDevice();
    if (device.onTv) setInterval(refreshDevice, 15000);

    // Loopback and not a web page from elsewhere: see hosts.js.
    const fromLoopback = (request) => require('./http/hosts.js').trustedLocal(request);

    const guard = pin.createGuard();

    // Phones only while the app is open on the TV, and a while after, unless set to always: see access.js.
    const access = createAccess({ config, log });
    launchedHook.run = () => access.launched();

    // `request` is the HTTP request or the socket's upgrade request: who is asking decides whose failures count.
    const authorise = (presented, request) => {
        const address = (request && request.socket && request.socket.remoteAddress) || 'unknown';
        const headers = (request && request.headers) || {};

        // A web page that is not this service's own cannot be the phone, so what it sends is not a guess to
        // count: otherwise any page a phone or the TV has open could lock that device out by sending five.
        if (headers.origin && !require('./http/hosts.js').trustedOrigin(headers.origin, headers.host)) {
            return { ok: false, code: ErrorCode.UNAUTHORIZED, message: 'Not from this TV\'s own page.' };
        }

        const state = guard.check(address, fromLoopback(request));

        if (state.locked) {
            const seconds = Math.ceil(state.remaining / 1000);
            return { ok: false, code: ErrorCode.LOCKED_OUT, message: `Too many incorrect PINs. Try again in ${seconds}s.` };
        }

        if (!pin.matches(presented, secret)) {
            guard.failed(address);
            return { ok: false, code: ErrorCode.UNAUTHORIZED, message: 'Wrong or missing PIN.' };
        }

        guard.succeeded(address);
        return { ok: true };
    };

    const lanAddresses = () => {
        const interfaces = require('os').networkInterfaces();
        const wiredFirst = (name) => (/^(eth|en)/.test(name) ? 0 : /^(wlan|wl)/.test(name) ? 1 : 2);

        return Object.entries(interfaces)
            .flatMap(([name, entries]) => (entries || [])
                .filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)
                .map((entry) => ({ address: entry.address, iface: name })))
            .sort((a, b) => wiredFirst(a.iface) - wiredFirst(b.iface));
    };

    // The TV's own page watches over the socket now, but these stay cheap to ask for and a phone or a
    // script may still sweep them, so they are logged at debug.
    const POLLED = ['/logs', '/state', '/pin', '/version', '/health'];

    const quiet = (request, path) =>
        request.method === 'GET' && fromLoopback(request) && POLLED.indexOf(path) !== -1;

    const router = createRouter({ log, quiet });

    router.on.get('/version', (_request, response) => json(response, {
        build: BUILD,
        node: process.version,
        runtime: runtime.describe(),

        startedAt,
        uptimeSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),

        // The gap between the two is the only visible sign that Tizen reloaded the service.
        processUptimeSeconds: Math.round(process.uptime())
    }));

    router.on.get('/health', (_request, response) => json(response, {
        ok: true,
        port: PORT,
        onTv: device.onTv,
        addresses: lanAddresses().map((entry) => entry.address)
    }));

    // What a caller on the television itself is allowed to know: the code, and where to reach this
    // from a phone. The socket says the same thing in its greeting, so the two cannot drift.
    const pairing = () => {
        const addresses = lanAddresses();

        return {
            pin: secret,
            port: PORT,
            addresses: addresses.map((entry) => entry.address),
            url: addresses.length ? `http://${addresses[0].address}:${PORT}` : null
        };
    };

    router.on.get('/pin', (request, response) => {
        if (!fromLoopback(request)) {
            return failure(response, 403, ErrorCode.UNAUTHORIZED, 'Only readable from the TV itself.');
        }

        json(response, pairing());
    });

    // Served from the last sweep: probing here made the set connect to its own sdbd twelve times a minute.
    router.on.get('/state', (request, response) => {
        if (!fromLoopback(request)) {
            return failure(response, 403, ErrorCode.UNAUTHORIZED, 'Only readable from the TV itself.');
        }

        json(response, store.select('device') || {});
    });

    const authorisedRead = (request, response, handle) => {
        if (fromLoopback(request)) return handle();

        const verdict = authorise(request.headers['x-homebrew-pin'], request);
        if (!verdict.ok) return failure(response, 403, verdict.code, verdict.message);

        return handle();
    };

    router.on.get('/logs', (request, response, { query }) =>
        authorisedRead(request, response, () =>
            json(response, { lines: recorded.since(query.get('since')), uptime: recorded.uptime() })));

    router.on.get('/packages', (request, response) =>
        authorisedRead(request, response, () =>
            packages.list().then(
                (list) => json(response, { ok: true, packages: list }),
                (error) => failure(response, 500, error.code || ErrorCode.INTERNAL, error.message))));

    if (DEVELOPER) {
        const { createRepl } = require('./dev/repl.js');

        const repl = createRepl({
            require, process, log, store, config, secret,
            catalog, library, updates, autoUpdate, installer, relay, device, sdb, packages, platform, runtime, memory
        });

        const gate = (request, response) => {
            const verdict = authorise(request.headers['x-homebrew-pin'], request);
            if (verdict.ok) return true;
            failure(response, verdict.code === ErrorCode.LOCKED_OUT ? 429 : 403, verdict.code, verdict.message);
            return false;
        };

        svc.warn(`repl: POST /dev/eval, with ${repl.names.join(' ')} in scope`);

        router.on.post('/dev/eval', async (request, response) => {
            if (!gate(request, response)) return;

            const source = (await readBody(request, 64 * 1024)).toString('utf8');

            svc.warn(`eval from ${host(request.socket && request.socket.remoteAddress)}: ` +
                source.replace(/\s+/g, ' ').slice(0, 200));

            json(response, await repl.evaluate(source));
        });

        router.on.post('/dev/inspect', (request, response) => {
            if (!gate(request, response)) return;

            const opened = repl.openInspector(Number(request.headers['x-homebrew-port']) || 9229);

            svc.warn(`inspector: ${opened.ok ? `open at ${opened.url}` : opened.error}`);
            json(response, opened);
        });
    }

    let uploading = false;

    router.on.post('/install', async (request, response) => {
        const verdict = authorise(request.headers['x-homebrew-pin'], request);
        if (!verdict.ok) return failure(response, verdict.code === ErrorCode.LOCKED_OUT ? 429 : 403, verdict.code, verdict.message);

        // Refused before the body is read: a second upload while one installs, or is still arriving, would
        // hold a second package.
        if (store.select('installing') || uploading) {
            request.resume();
            return failure(response, 409, 'busy', 'An install is already running.');
        }

        const phases = [];
        const began = Date.now();

        uploading = true;
        let archive;
        try {
            archive = await readBody(request);
        } catch (error) {
            // A phone that walked out of wifi range: said once, without a trace, and nothing to answer.
            log.on(Facility.PKG).warn(`upload from ${host(request.socket && request.socket.remoteAddress)} stopped: ${error.message}`);
            if (!response.headersSent && !response.destroyed) failure(response, 400, ErrorCode.BAD_MESSAGE, error.message);
            return undefined;
        } finally {
            uploading = false;
        }

        log.on(Facility.PKG).info(`${host(request.socket && request.socket.remoteAddress)} uploaded ` +
            `${size(archive.length)}${request.headers['x-homebrew-name'] ? ` as ${request.headers['x-homebrew-name']}` : ''} ` +
            `in ${took(Date.now() - began)}`);

        // Handed to the install in the request it reads, and let go here: the pipeline drops it from that
        // request once it has it, so the upload is not held for the minutes the TV installs.
        const asked = { source: 'upload', reference: request.headers['x-homebrew-name'], upload: archive };
        archive = null;

        try {
            const outcome = await installer.install(asked, (phase, detail) => phases.push(detail ? `${phase}: ${detail}` : phase));

            updates.changed();

            json(response, { ok: true, phases, ...outcome });
        } catch (error) {
            failure(response, 500, error.code || ErrorCode.INTERNAL, error.message, error.remedy);
            log.on(Facility.PKG).err(`upload install stopped after: ${phases.join(', ') || 'nothing'}`);
        }
    });

    router.on.post('/certificates', async (request, response) => {
        const verdict = authorise(request.headers['x-homebrew-pin'], request);
        if (!verdict.ok) return failure(response, verdict.code === ErrorCode.LOCKED_OUT ? 429 : 403, verdict.code, verdict.message);

        const sent = await readBody(request, 4 * 1024 * 1024);

        const pair = (() => {
            try {
                return JSON.parse(sent.toString('utf8'));
            } catch (e) {
                return null;
            }
        })();

        const devices = ((pair || {}).devices || []).filter((name) => typeof name === 'string' && name);

        const opened = (() => {
            try {
                return require('./install/resign.js').openPair(pair);
            } catch (error) {
                return { error };
            }
        })();

        if (opened.error) {
            return failure(response, 400, ErrorCode.BAD_MESSAGE, opened.error.message);
        }

        const device = devices[0] || null;
        const state = store.select('device');
        const here = state && state.duid;

        config.update({
            author: pair.author,
            distributor: pair.distributor,
            certDuid: device,
            certDuids: devices,
            certCreatedAt: new Date().toISOString()
        });

        const mismatched = Boolean(here && devices.length && devices.indexOf(here) === -1);

        log.on(Facility.CFG)[mismatched ? 'warn' : 'ok'](
            `certificates stored for ${devices.join(', ') || 'an unnamed device'}` +
            (mismatched ? `, but this television is ${here} — installs will be refused` : ''));

        json(response, { ok: true, device, devices, matchesThisTv: !mismatched, thisTv: here || null });
    });

    router.on.delete('/certificates', (request, response) => {
        const verdict = authorise(request.headers['x-homebrew-pin'], request);
        if (!verdict.ok) return failure(response, 403, verdict.code, verdict.message);

        config.forgetCertificates();
        log.on(Facility.CFG).info('certificates forgotten');

        json(response, { ok: true });
    });

    // Exiting is all the service can do about its own lifetime: the UI page holds no privilege to stop
    // a sibling application. What brings it back is config.xml — auto-restart if the platform honours
    // it, and the page's own launchAppControl if it does not.
    const exitAfterResponse = (payload, asked, why) => (request, response) => {
        const verdict = authorise(request.headers['x-homebrew-pin'], request);

        if (!verdict.ok) {
            return failure(response, verdict.code === ErrorCode.LOCKED_OUT ? 429 : 403, verdict.code, verdict.message);
        }

        json(response, { ok: true, build: BUILD, ...payload });

        svc.warn(`${host(request.socket && request.socket.remoteAddress)} asked the service to ${asked}`);

        // sdbd is told the connection is going, rather than finding out from a reset when this exits.
        sdb.release();

        // The response has to clear the socket first, because the caller waits on it.
        setTimeout(() => {
            svc.info(`exiting after ${took(recorded.uptime())} ${why}`);
            process.exit(0);
        }, 300);
    };

    router.on.post('/restart', exitAfterResponse(
        { restarting: true }, 'restart', 'so the platform reloads it on new code'));

    router.on.post('/shutdown', exitAfterResponse(
        { stopping: true }, 'stop', 'because someone asked it to'));

    const uiRoot = [
        join(__dirname, '..', '..', 'ui', 'dist'),
        join(__dirname, '..', 'ui', 'dist'),
        join(__dirname, '..', '..', 'ui')
    ].find(existsSync);

    if (uiRoot) {
        svc.info(`serving the phone UI from ${uiRoot}`);
    } else {
        svc.err('no UI assets in this build — the phone will get a 500 and nothing else');
    }

    // App icons, by package id. Not behind the PIN, which an <img> cannot send, but behind a token in the
    // address only paired phones are given, so no page can probe which apps are installed. Cached by the
    // phone; the address changes when the picture does.
    router.on.get('/icons/*', (request, response, { path, query }) => {
        const found = appIcons.read(path.slice('/icons/'.length), query.get('t'));
        if (!found) return failure(response, 404, ErrorCode.NOT_FOUND, 'No icon kept for that app.');

        response.writeHead(200, {
            'content-type': found.type,
            'content-length': found.bytes.length,
            'cache-control': 'public, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'"
        });
        response.end(found.bytes);
    });

    router.on.get('/*', (request, response, { path }) => {
        if (!uiRoot) return failure(response, 500, ErrorCode.INTERNAL, 'UI assets are missing from this build.');

        const requested = path === '/' ? '/index.html' : path;
        const file = join(uiRoot, normalize(requested));

        // Confirms the collapsed path is still inside the UI directory — this would serve any file on the TV.
        // Compared with the separator, or `ui/dist-old` would count as inside `ui/dist`.
        if (!file.startsWith(uiRoot + sep) || !existsSync(file)) {
            return failure(response, 404, ErrorCode.NOT_FOUND, `No such file: ${requested}`);
        }

        const types = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.png': 'image/png',
            '.wav': 'audio/wav'
        };

        const type = types[extname(file)] || 'application/octet-stream';
        const length = require('fs').statSync(file).size;

        // Streamed rather than read whole, and cached by the phone: the page itself is asked for fresh
        // each time, so an update shows at once; its sound and pictures need not travel again.
        response.writeHead(200, {
            'content-type': type.startsWith('text/') || type.endsWith('javascript') ? `${type}; charset=utf-8` : type,
            'content-length': length,
            'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=86400',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer'
        });

        require('fs').createReadStream(file).on('error', () => response.destroy()).pipe(response);
    });

    // What a phone gets while it is not let in: the page says what to do and looks again by itself, so it
    // carries on the moment the app is opened on the TV; anything else gets the reason as an error.
    const CLOSED_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10">' +
        '<title>Tizen Homebrew</title></head>' +
        '<body style="margin:0;padding:12vh 8vw;background:#0d2633;color:#dfeaf0;font:1.1rem/1.5 system-ui,sans-serif">' +
        '<h1 style="font-size:1.3rem;font-weight:600">Open Tizen Homebrew on the TV</h1>' +
        '<p>Phones can reach it while the app is open on the TV, and for a while after.</p>' +
        '<p style="color:#9bb2c0">This page looks again every 10 seconds.</p></body></html>';

    const refusedAt = new Map();

    const closedToPhones = (request, response) => {
        const address = host(request.socket && request.socket.remoteAddress);
        const last = refusedAt.get(address) || 0;

        if (Date.now() - last > 60000) {
            refusedAt.delete(address);
            refusedAt.set(address, Date.now());
            Array.from(refusedAt.keys()).slice(0, Math.max(0, refusedAt.size - 64)).forEach((old) => refusedAt.delete(old));
            log.on(Facility.AUTH).info(`${address} asked while phone access is closed — open the app on the TV to let it in`);
        }

        request.resume();

        const wantsPage = request.method === 'GET' && /^\/(index\.html)?(\?|$)/.test(request.url || '/');

        if (!wantsPage) {
            return failure(response, 403, ErrorCode.PHONE_ACCESS_CLOSED, 'Open Tizen Homebrew on the TV to use it from a phone.');
        }

        response.writeHead(403, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(CLOSED_PAGE),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'"
        });

        return response.end(CLOSED_PAGE);
    };

    const { allowedHost } = require('./http/hosts.js');

    const server = createServer((request, response) => {
        if (!allowedHost(request.headers.host)) {
            net.warn(`refused a request for the host "${request.headers.host}" — not an address this TV answers to`);
            return failure(response, 403, ErrorCode.UNAUTHORIZED,
                'Reach this TV by its IP address. (A development machine reaching it by name can list that name ' +
                'in HOMEBREW_HOSTNAMES.)');
        }

        if (!access.allows(request)) return closedToPhones(request, response);

        return router.listener(request, response);
    });

    // A failed bind arrives as an event, so without this nothing listens and nothing says so.
    server.on('error', (error) => {
        net.err(`cannot listen on ${PORT}: ${error.message}`);

        if (error.code === 'EADDRINUSE') {
            net.err('another app or a system service has claimed that port — trying again shortly');

            // The same server tried again, rather than a second start with a second set of timers — every
            // 10s at first, then once a minute, for as long as it takes.
            listenAttempts += 1;
            setTimeout(() => server.listen(PORT, '0.0.0.0'), listenAttempts < 30 ? 10000 : 60000);
        }
    });

    let listenAttempts = 0;

    server.on('listening', () => { listenAttempts = 0; });

    server.listen(PORT, '0.0.0.0', () => {
        net.ok(`listening on 0.0.0.0:${PORT}`);

        const addresses = lanAddresses();

        if (addresses.length === 0) {
            net.warn('no LAN address — this TV is not on a network, so no phone can reach it');
        }

        addresses.forEach((entry, index) => net.info(
            `${index === 0 ? 'reachable at' : 'also at'} http://${entry.address}:${PORT} (${entry.iface})`));

        svc.ok(`startup finished in ${took(recorded.uptime())}`);

    });

    sockets = require('./socket.js').attach({
        server, store, secret, authorise, installer, library, updates, autoUpdate, relay, refreshDevice,
        fromLoopback, access, greeting: () => ({ ...pairing(), build: BUILD }), recorded, config, protocol, log
    });

    // The built-in list, loaded once at start so a phone finds it ready. The service starts with the
    // television, often before its network is up, and with no copy kept yet a failure used to stay until
    // somebody pressed refresh: it is tried again by itself, soon at first, then less often, until it loads.
    const RETRY_AFTER = [30, 60, 120, 300, 900].map((seconds) => seconds * 1000);

    const loadBuiltIn = (attempt) => catalog.fetch().then(
        (result) => {
            if (attempt === 0) return;
            log.on(Facility.CAT).ok(`built-in list loaded on try ${attempt + 1}: ${result.entries.length} apps`);
            if (sockets) sockets.pushCatalog().catch((error) => log.on(Facility.CAT).warn(`could not send the lists: ${error.message}`));
        },
        (error) => {
            const wait = RETRY_AFTER[Math.min(attempt, RETRY_AFTER.length - 1)];
            log.on(Facility.CAT).warn(`built-in list not loaded (${error.message}) — trying again in ${took(wait)}`);

            const later = setTimeout(() => loadBuiltIn(attempt + 1), wait);
            if (later.unref) later.unref();
        });

    if (device.onTv) loadBuiltIn(0);

    // With nothing to do while the app is closed, the service stops and gives its memory back: see idle.js.
    const idle = createIdle({ config, access, store, log, onTv: device.onTv });
    if (device.onTv) idle.start();

    process.__homebrewStarted = { server, port: PORT, pin: secret, build: BUILD };

    return process.__homebrewStarted;
};

// Tizen's service runtime calls onStart; a service exporting anything else loads and never listens.
module.exports.onStart = start;
module.exports.start = start;

// Tizen calls onRequest for launches into a running service; without it the runner throws on each one.
module.exports.onRequest = () => {
    log.on(Facility.SVC).debug('a launch reached a service that is already running');

    // The app was opened on the TV: phones are let in now, before its page has even connected.
    launchedHook.run();
};
module.exports.BUILD = BUILD;
module.exports.PORT = PORT;

if (!device.onTv) start();
