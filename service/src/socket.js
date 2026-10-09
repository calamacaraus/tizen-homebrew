'use strict';

// HTTP answers single questions; the socket handles everything that unfolds. `protocol.js` fixes the shapes.

const { readdirSync, statSync, realpathSync } = require('fs');
const { join, normalize } = require('path');

// Where removable storage is mounted on a television. Browsing is for finding a package on a stick, so
// the rest of the disk — the configuration with the signing keys in it, other apps' data — is not listed.
// HOMEBREW_MEDIA_ROOTS (colon-separated) widens it, for a model that mounts elsewhere.
const MEDIA_ROOTS = (process.env.HOMEBREW_MEDIA_ROOTS || '/media:/opt/media:/opt/usr/media:/mnt:/storage')
    .split(':').filter(Boolean);

const insideMedia = (path) => {
    const resolved = (() => {
        try {
            return realpathSync(normalize(path));
        } catch (e) {
            return normalize(path);
        }
    })();

    return MEDIA_ROOTS.some((root) => resolved === root || resolved.indexOf(`${root}/`) === 0);
};

const WebSocket = require('ws');

const preview = require('./install/preview.js');
const { allowedHost } = require('./http/hosts.js');
const sources = require('./install/sources.js');
const customize = require('./install/customize.js');
const { took, host } = require('./obs/units.js');

const CLOSED_BECAUSE = {
    1000: 'normally',
    1001: 'the page went away',
    1005: 'no reason given',
    1006: 'abnormally — the network dropped',
    1011: 'the service faulted',
    1012: 'the service is restarting'
};

const attach = ({ server, store, authorise, installer, library, updates, autoUpdate, relay, refreshDevice,
    fromLoopback, greeting, recorded, config, protocol, log, latestRelease = sources.latestRelease }) => {
    const { Inbound, Outbound, ErrorCode, ProtocolError } = protocol;

    const say = log ? log.on('sock') : null;
    const auth = log ? log.on('auth') : null;

    // A browser sends the page's origin with every WebSocket handshake, and any web page the phone has open
    // could otherwise reach this socket and spend the five PIN attempts — or, holding a PIN somehow, act
    // with it. Let in: clients that are not browsers (no Origin: the CLI tools); this service's own page;
    // a development server on localhost; and, from the television itself, its own packaged page, whose
    // origin is file:// or app:// rather than a web address. A web site is refused wherever it is open —
    // including the TV's own browser, which would otherwise be handed the code in the loopback greeting.
    const allowedOrigin = (info) => {
        const headers = (info.req && info.req.headers) || {};
        if (!allowedHost(headers.host)) return false;

        const origin = info.origin || headers.origin;
        if (!origin) return true;

        const address = (info.req && info.req.socket && info.req.socket.remoteAddress) || '';
        const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].indexOf(address) !== -1;

        let parsed = null;

        try {
            parsed = new URL(origin);
        } catch (e) {
            parsed = null;
        }

        const web = parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:');

        if (!web) return loopback;

        const host = String(headers.host || '').toLowerCase();
        const local = ['localhost', '127.0.0.1', '[::1]'].indexOf(parsed.hostname.toLowerCase()) !== -1;

        return parsed.host.toLowerCase() === host || local;
    };

    // Every message is a small JSON frame; uploads go over HTTP. Left at ws's 100MB default, one frame
    // could hold the television's memory hostage before parse() ever saw it.
    const wsServer = new WebSocket.Server({
        server,
        // Room for one custom icon (384KB, as base64) and nothing much more.
        maxPayload: 640 * 1024,
        verifyClient: (info) => {
            const allowed = allowedOrigin(info);
            if (!allowed && auth) auth.warn(`refused a socket from the web page at ${info.origin}`);
            return allowed;
        }
    });

    let connected = 0;

    // Everyone the service pushes to unasked. A phone gets what it asks for; the television's own
    // page asks once and is then told, which is what replaced its second-by-second polling.
    const watchers = [];

    // Every paired connection, phone or television, for what all of them should hear at once: an update
    // run's progress, and a setting someone changed.
    const paired_ = [];

    wsServer.on('connection', (socket, request) => {
        let paired = false;
        let unwatch = null;

        const client = host((request && request.socket && request.socket.remoteAddress) ||
            (socket._socket && socket._socket.remoteAddress));
        const openedAt = Date.now();

        connected += 1;
        if (say) say.info(`${client} connected (${connected} ${connected === 1 ? 'client' : 'clients'})`);

        socket.on('close', (code, reason) => {
            connected = Math.max(0, connected - 1);

            if (unwatch) unwatch();

            const watching = watchers.indexOf(push);
            if (watching !== -1) watchers.splice(watching, 1);

            const listening = paired_.indexOf(push);
            if (listening !== -1) paired_.splice(listening, 1);

            if (!say) return;

            const why = CLOSED_BECAUSE[code] || (reason ? String(reason) : `code ${code}`);
            say.info(`${client} disconnected ${why} after ${took(Date.now() - openedAt)} ` +
                `(${connected} ${connected === 1 ? 'client' : 'clients'})`);
        });

        const send = (type, payload) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(protocol.encode(type, payload));
        };

        // Named so `close` can take it back out of `watchers`; `send` itself is fine to hold on to.
        const push = (type, payload) => send(type, payload);

        const sendFailure = (error) => {
            // A coded error is a refusal this service meant to make; only a surprise gets a trace.
            const expected = Boolean(error && error.code);

            if (say) {
                say[expected ? 'warn' : 'err'](`${client} refused: ` +
                    `${(error && error.code) || 'internal'} — ${(error && error.message) || 'unexpected failure'}`);
            }

            if (!expected) console.error(error && error.stack ? error.stack : error);

            send(Outbound.ERROR, {
                code: expected ? error.code : ErrorCode.INTERNAL,
                message: (error && error.message) || 'Unexpected failure.',
                // Only on failures verdicts.js recognized: what to do, which the UI cannot know.
                remedy: (error && error.remedy) || null,
                fatal: false
            });
        };

        const sendDeviceState = async () => {
            const state = await refreshDevice();
            send(Outbound.STATE, { ...state, hasCertificates: config.hasCertificates() });
        };

        // The tail first, from the sequence number the caller already has, then every line as it is
        // written. A reconnect resumes rather than repeating, and a service that restarted answers
        // with a lower uptime, which is how the page knows to start its log again.
        const startWatching = ({ logsSince }) => {
            if (unwatch) unwatch();

            send(Outbound.LOG, { lines: recorded.since(logsSince), uptime: recorded.uptime() });

            unwatch = recorded.subscribe((lines) => send(Outbound.LOG, { lines, uptime: recorded.uptime() }));

            if (watchers.indexOf(push) === -1) watchers.push(push);

            return sendDeviceState();
        };

        const greet = async ({ pin }) => {
            const verdict = authorise(pin);

            if (!verdict.ok) {
                if (auth) auth.warn(`${client} ${verdict.code === ErrorCode.LOCKED_OUT ? 'is locked out' : 'gave the wrong PIN'}`);

                if (verdict.code === ErrorCode.LOCKED_OUT) return sendFailure(ProtocolError(verdict.code, verdict.message));
                return send(Outbound.HELLO, { ok: false, needsPin: true });
            }

            paired = true;
            if (paired_.indexOf(push) === -1) paired_.push(push);
            if (auth) auth.ok(`${client} paired`);
            send(Outbound.HELLO, { ok: true, needsPin: false });
            send(Outbound.RELAY_STATE, { enabled: relay.enabled });

            await sendDeviceState();
        };

        const sendCatalog = async (result) => {
            store.update({ catalog: result.entries, catalogStale: result.stale });

            // Marked from the kept listing rather than by asking the set, so the list draws now.
            send(Outbound.CATALOG, {
                entries: await updates.mark(result.entries),
                stale: result.stale,
                source: result.source,
                repositories: result.repositories || []
            });
        };

        const listCatalog = async ({ refresh }) => sendCatalog(await library.fetch({ refresh: !!refresh }));

        // One app asks GitHub about that app; everything also asks each collection what its newest
        // release holds now, so a rebuilt file in one is seen without a full refresh.
        const checkUpdates = async ({ id }) => {
            const result = id ? null : await library.fetch({ refresh: 'collections' });
            if (result) store.update({ catalog: result.entries, catalogStale: result.stale });

            const entries = store.select('catalog') || [];

            send(Outbound.CATALOG, {
                entries: await updates.check(entries, { id: id || null }),
                stale: Boolean(store.select('catalogStale')),
                source: 'cache',
                repositories: result ? result.repositories : undefined
            });
        };

        const listRelease = async ({ ref }) => {
            const release = await latestRelease(ref);

            send(Outbound.RELEASE, {
                repo: sources.repoOf(ref),
                tag: release.tag_name || null,
                name: release.name || null,
                publishedAt: release.published_at || null,
                assets: sources.packagesIn(release)
            });
        };

        const sendRepositories = async () => {
            const result = await library.fetch({});
            send(Outbound.REPOSITORIES, { repositories: result.repositories });
            await sendCatalog(result);
        };

        const addRepository = async ({ ref }) => {
            if (say) say.info(`${client} adds the repository ${ref}`);
            await library.add(ref);
            await sendRepositories();
        };

        const removeRepository = async ({ id }) => {
            library.remove(id);
            await sendRepositories();
        };

        const sendSettings = () => send(Outbound.SETTINGS, autoUpdate.settings());

        const setSettings = ({ autoUpdate: mode }) => {
            if (mode) {
                config.update({ autoUpdate: mode });
                if (say) say.info(`${client} set automatic updates to ${mode}`);
            }

            broadcastPaired(Outbound.SETTINGS, autoUpdate.settings());
        };

        // Progress reaches every paired screen through autoUpdate's broadcast; this answers with the catalog
        // as it stands afterwards.
        // Icons go out as data URIs, so the phone shows the tile it will get without asking again. All of them
        // when a phone asks; only the one that changed when somebody changes one.
        const describeCustomization = (custom) => {
            const bytes = custom.icon ? customize.iconBytes(config.CONFIG_DIR, custom.icon) : null;

            return {
                name: custom.name || null,
                icon: bytes ? `data:${custom.icon.type};base64,${bytes.toString('base64')}` : null,
                at: custom.at || null
            };
        };

        const sendCustomizations = () => {
            const kept = config.read().customizations || {};

            send(Outbound.CUSTOMIZATIONS, {
                items: Object.keys(kept).reduce((items, packageId) => {
                    items[packageId] = describeCustomization(kept[packageId]);
                    return items;
                }, {})
            });
        };

        // Where this package was installed from, so it can be installed again with the change in it.
        const sourceOf = (packageId) =>
            customize.sourceFor(store.select('catalog'), config.read().installedFrom, packageId);

        const setCustomization = async (payload) => {
            const { packageId, reset, apply } = payload;
            const kept = { ...(config.read().customizations || {}) };
            const previous = kept[packageId] || null;

            if (reset) {
                delete kept[packageId];
            } else {
                if (!previous && Object.keys(kept).length >= customize.MAX_CUSTOMIZED) {
                    throw ProtocolError(ErrorCode.BAD_MESSAGE,
                        `Up to ${customize.MAX_CUSTOMIZED} apps can be customised; reset one first.`);
                }

                // Left out means "as it was"; null means "back to the app's own".
                const checked = customize.validate({
                    packageId,
                    name: 'name' in payload ? payload.name : previous && previous.name,
                    icon: 'icon' in payload ? payload.icon : null
                });

                let icon = previous ? previous.icon || null : null;

                if ('icon' in payload && checked.icon) {
                    const others = Object.keys(kept)
                        .filter((id) => id !== packageId)
                        .reduce((total, id) => total + customize.storedSize(config.CONFIG_DIR, kept[id].icon), 0);

                    if (others + Buffer.byteLength(checked.icon.data, 'base64') > customize.MAX_ICONS_TOTAL) {
                        throw ProtocolError(ErrorCode.TOO_LARGE,
                            'The custom icons together are at their limit; reset one, or use a simpler picture.');
                    }

                    // Written before anything is removed, so a failed write leaves the old icon where it was.
                    icon = customize.storeIcon(config.CONFIG_DIR, packageId, checked.icon);
                } else if ('icon' in payload) {
                    icon = null;
                }

                if (!checked.name && !icon) delete kept[packageId];
                else kept[packageId] = { name: checked.name, icon, at: new Date().toISOString() };
            }

            config.update({ customizations: kept });

            // The old file goes only once the configuration no longer points at it.
            const now = kept[packageId] && kept[packageId].icon;
            if (previous && previous.icon && (!now || now.file !== previous.icon.file)) {
                customize.dropIcon(config.CONFIG_DIR, previous.icon);
            }
            if (say) say.info(`${client} ${reset ? 'reset' : 'customised'} ${packageId}`);

            broadcastPaired(Outbound.CUSTOMIZATIONS, {
                items: { [packageId]: kept[packageId] ? describeCustomization(kept[packageId]) : null },
                partial: true
            });

            if (!apply) return;

            const from = sourceOf(packageId);

            if (!from) {
                throw ProtocolError(ErrorCode.SAVED_NOT_APPLIED,
                    'No list Homebrew knows has this app, so it cannot fetch it again by itself. Install it once more from ' +
                    'where it came from (upload, GitHub or URL) to see the change now; every update after that keeps it.');
            }

            await runInstall({ source: 'catalog', ref: from });
        };

        // An install already running is waited for inside the run, so this is never refused for being busy.
        const updateAll = async ({ includeRebuilt }) => {
            if (say) say.info(`${client} asked to update everything${includeRebuilt ? ', rebuilds included' : ''}`);

            await autoUpdate.run({ trigger: 'asked', includeRebuilt: Boolean(includeRebuilt) });
            await listCatalog({ refresh: false });
        };

        const describe = ({ source, ref }) => `${source} ${ref}`;

        const runInstall = async ({ source, ref, asset }) => {
            if (source === 'file' && !insideMedia(ref)) {
                return sendFailure(ProtocolError(ErrorCode.NOT_FOUND, 'Only a package on removable storage can be installed from a file.'));
            }

            if (say) say.info(`${client} asked to install ${describe({ source, ref })}${asset ? ` (${asset})` : ''}`);

            try {
                const outcome = await installer.install(
                    { source, reference: ref, asset: asset || null },
                    (phase, detail, extra) => send(Outbound.PROGRESS, {
                        phase,
                        detail: detail || null,
                        identity: (extra && extra.identity) || null
                    })
                );

                updates.changed();

                send(Outbound.DONE, outcome);
            } catch (error) {
                if (error.code === ErrorCode.CERTS_MISSING) {
                    const state = store.select('device');
                    send(Outbound.NEEDS_CERTS, { ip: state ? state.deviceIp : null });
                }
                sendFailure(error);
            }
        };

        const listDirectory = ({ path }) => {
            const root = path || '/media';

            if (!insideMedia(root)) {
                return sendFailure(ProtocolError(ErrorCode.NOT_FOUND, `Cannot read ${root}: only removable storage is browsable.`));
            }

            const readable = (() => {
                try {
                    return readdirSync(root);
                } catch (e) {
                    return null;
                }
            })();

            if (!readable) return sendFailure(ProtocolError(ErrorCode.NOT_FOUND, `Cannot read ${root}.`));

            const isPackage = (name) => /\.(wgt|tpk)$/i.test(name);

            const entries = readable.reduce((found, name) => {
                const full = join(root, name);

                try {
                    const stats = statSync(full);

                    if (!stats.isDirectory() && !isPackage(name)) return found;

                    // Opened far enough to learn what it calls itself; a filename is not that.
                    return found.concat({
                        name,
                        path: full,
                        isDirectory: stats.isDirectory(),
                        size: stats.isDirectory() ? null : stats.size,
                        identity: stats.isDirectory() ? null : preview.describeFile(full)
                    });
                } catch (e) {
                    return found; // Unreadable entries are simply not offered.
                }
            }, [{ name: '..', path: MEDIA_ROOTS.indexOf(root) !== -1 ? root : join(root, '..'), isDirectory: true }]);

            send(Outbound.DIR, entries);
        };

        const setRelay = ({ enabled, persist }) => {
            if (say) say.warn(`${client} turned the command relay ${enabled ? 'on' : 'off'}${persist ? ', and stored that' : ''}`);

            relay.setEnabled(enabled);

            // A second opt-in, so one job does not leave shell access open for good.
            if (persist) config.update({ relayEnabled: relay.enabled });

            send(Outbound.RELAY_STATE, { enabled: relay.enabled });
        };

        const runRelayCommand = async ({ id, command, timeout }) => {
            try {
                const result = await relay.exec(id, command, {
                    timeout,
                    onChunk: (chunk) => send(Outbound.RELAY_DATA, { id, chunk })
                });

                send(Outbound.RELAY_END, {
                    id,
                    output: result.output,
                    truncated: result.truncated,
                    timedOut: !!result.timedOut
                });
            } catch (error) {
                sendFailure(error);
            }
        };

        // Minting needs a Samsung account, so the pair is made on a computer and sent here.
        const createCertificates = () => sendFailure(ProtocolError(
            ErrorCode.RESIGN_FAILED,
            'Certificates are minted on a computer and sent to this TV with `npm run certs`. ' +
            'Signing into a Samsung account from here is not supported.'
        ));

        const forgetCertificates = async () => {
            config.forgetCertificates();
            await sendDeviceState();
        };

        const handlers = {
            [Inbound.HELLO]: greet,
            [Inbound.GET_STATE]: sendDeviceState,
            [Inbound.WATCH]: startWatching,
            [Inbound.GET_CATALOG]: listCatalog,
            [Inbound.CHECK_UPDATES]: checkUpdates,
            [Inbound.INSTALL]: runInstall,
            [Inbound.UPDATE_ALL]: updateAll,
            [Inbound.LIST_RELEASE]: listRelease,
            [Inbound.GET_REPOSITORIES]: sendRepositories,
            [Inbound.ADD_REPOSITORY]: addRepository,
            [Inbound.REMOVE_REPOSITORY]: removeRepository,
            [Inbound.GET_SETTINGS]: sendSettings,
            [Inbound.SET_SETTINGS]: setSettings,
            [Inbound.GET_CUSTOMIZATIONS]: sendCustomizations,
            [Inbound.SET_CUSTOMIZATION]: setCustomization,
            [Inbound.LIST_DIR]: listDirectory,
            [Inbound.SET_RELAY]: setRelay,
            [Inbound.RELAY_EXEC]: runRelayCommand,
            [Inbound.SUBMIT_ACCESS_INFO]: createCertificates,
            [Inbound.FORGET_CERTS]: forgetCertificates
        };

        // The television's own page arrives over loopback, which `GET /pin` already trusts with the
        // code. Handing it over in the greeting saves that page a request and leaves one path to
        // authorisation, rather than a second one that skips it.
        const opening = fromLoopback && fromLoopback(request) && greeting ? greeting() : null;

        send(Outbound.HELLO, { ok: false, needsPin: true, ...(opening || {}) });

        socket.on('message', async (raw) => {
            const message = (() => {
                try {
                    return protocol.parse(raw);
                } catch (error) {
                    sendFailure(error);
                    return null;
                }
            })();

            if (!message) return;

            if (!paired && message.type !== Inbound.HELLO) {
                return sendFailure(ProtocolError(ErrorCode.UNAUTHORIZED, 'Enter the PIN shown on the TV first.'));
            }

            if (say && message.type !== Inbound.HELLO) say.info(`${client} ${message.type}`);

            try {
                await handlers[message.type](message.payload);
            } catch (error) {
                sendFailure(error);
            }
        });

        socket.on('error', (error) => {
            if (say) say.err(`${client} socket error: ${error.message}`);
        });
    });

    // Anything the service learns on its own rather than on being asked: the device state sweep is
    // the only caller today.
    const broadcast = (type, payload) => watchers.slice().forEach((to) => to(type, payload));

    function broadcastPaired(type, payload) {
        paired_.slice().forEach((to) => to(type, payload));
    }

    return { wsServer, broadcast, broadcastPaired };
};

module.exports = { attach };
