'use strict';

// Six named steps, each taking the work so far further along. Every route runs this same sequence.

const { createHash } = require('crypto');

const sources = require('./sources.js');
const manifest = require('./manifest.js');
const zip = require('./zip.js');
const customize = require('./customize.js');

// Re-signing unpacks every file into memory, so an archive that says it expands past this is refused before
// it is opened — a zip bomb would otherwise end the service partway through an install.
const MAX_EXPANDED = 512 * 1024 * 1024;
const preview = require('./preview.js');
const installer = require('./installer.js');
const { size, took, rate } = require('../obs/units.js');
const memory = require('../obs/memory.js');

// Failures after which the TV may still be installing the staged file.
const UNKNOWN_OUTCOME = ['sdbTimeout', 'sdbClosed', 'sdbReset'];

const refuse = (code, message) => Object.assign(new Error(message), { code });

const QUIET = ['debug', 'info', 'ok', 'warn', 'err']
    .reduce((noop, level) => ({ ...noop, [level]: () => {} }), {});

const createInstaller = ({ sdb, device, config, resigner, store, log, appIcons = null }) => {
    const say = log ? log.on('pkg') : QUIET;
    const sdbSays = log ? log.on('sdb') : QUIET;

    const install = async (request, report = () => {}) => {
        if (store.select('installing')) {
            say.warn('refused: an install is already running');
            throw refuse('busy', 'An install is already running.');
        }

        store.update({ installing: true });

        const held = memory.peak();
        const phase = (name, detail, extra) => {
            held.at(name);
            report(name, detail, extra);
        };

        const startedAt = Date.now();
        const at = () => Date.now() - startedAt;

        say.info(`install requested: ${request.source} ${request.reference || '(upload)'}`);

        const probeReadiness = async () => {
            phase('probing');

            const state = await device.probe();

            say.info(state.onTv
                ? `television is tizen ${state.platformVersion || 'unknown'}` +
                  `${state.needsResign ? ', which requires re-signed packages' : ''}` +
                  `, sdb ${state.ready ? 'reachable' : `unreachable — ${state.sdbDetail || state.sdbError || state.reason || 'unknown'}`}`
                : 'no television here — running as a development harness');

            if (state.onTv && !state.ready) {
                // The remedy comes after the fault and only as the thing that would explain it.
                throw refuse(
                    state.reason === 'debugModeOff' ? 'debugModeOff' : 'sdbUnreachable',
                    `${state.sdbDetail || `sdb was unreachable (${state.sdbError || state.reason || 'unknown'})`} ` +
                    (state.reason === 'debugModeOff'
                        ? 'Developer Mode is off in Apps › 12345 › Settings.'
                        : 'If it stays this way, Host PC IP = 127.0.0.1 and a restart is what fixes a misconfigured one.')
                );
            }

            return { state };
        };

        const acquirePackage = async (carried) => {
            phase('fetching', request.reference || request.source);

            const began = Date.now();

            const { archive, name, expected, origin } = await sources.resolve({
                ...request,
                catalog: store.select('catalog') || [],
                log
            });

            const spent = Date.now() - began;
            const sha256 = createHash('sha256').update(archive).digest('hex');

            say.ok(`got ${name}: ${size(archive.length)} in ${took(spent)} (${rate(archive.length, spent)})`);

            // Checked before anything reads the archive: a file that is not the one published is not
            // opened, signed or installed, whatever it says it is.
            if (expected && expected !== sha256) {
                throw refuse('checksumMismatch',
                    `${name} does not match its published sha256 (expected ${expected.slice(0, 16)}…, ` +
                    `got ${sha256.slice(0, 16)}…). It was not installed.`);
            }

            say.info(`sha256 ${sha256.slice(0, 16)}…${expected ? ' — matches the published checksum' : ''}`);

            return { ...carried, archive, name, sha256, verified: Boolean(expected), origin: origin || null };
        };

        // Read as it arrived: a file that is not a package should be refused before anything signs it.
        const readIdentity = (carried) => {
            const expanded = zip.expandedSize(zip.fromBuffer(carried.archive));

            if (expanded !== null && expanded > MAX_EXPANDED) {
                throw refuse('tooLarge', `${carried.name || 'That package'} expands to ${size(expanded)}, ` +
                    `more than the ${size(MAX_EXPANDED)} this TV re-signs in memory.`);
            }

            const identity = manifest.identify(carried.archive);

            say.info(`identified ${identity.name || 'an unnamed package'} ${identity.version || ''} ` +
                `(${identity.packageId}${identity.appId ? `, app ${identity.appId}` : ''}, ${identity.isWgt ? 'wgt' : 'tpk'})`);

            return { ...carried, identity, described: preview.describe(carried.archive, identity) };
        };

        // Your own name and icon for this package, if you set them: changed before signing, so they are signed.
        const applyCustomization = async (carried) => {
            const stored = (config.read().customizations || {})[carried.identity.packageId];
            if (!stored) return carried;

            const bytes = stored.icon ? customize.iconBytes(config.CONFIG_DIR, stored.icon) : null;
            const custom = { name: stored.name, icon: bytes ? { type: stored.icon.type, bytes } : null };

            const { archive, changed, iconFile } = await customize.apply(carried.archive, carried.identity, custom);
            if (!changed) return carried;

            say.info(`applied your ${[custom.name ? `name "${custom.name}"` : null, iconFile ? 'icon' : null]
                .filter(Boolean).join(' and ')} to ${carried.identity.packageId}`);

            const identity = {
                ...carried.identity,
                name: custom.name || carried.identity.name,
                iconPath: iconFile || carried.identity.iconPath
            };

            return { ...carried, archive, identity, described: preview.describe(archive, identity) };
        };

        // Always re-signed with this TV's own pair: from Tizen 7 the set checks the certificate is its own.
        const resign = async (carried) => {
            // Sent before the certificate check, so a refusal names the application rather than the file.
            phase('resigning', carried.identity.name || carried.identity.packageId,
                { identity: carried.described });

            if (!config.hasCertificates(carried.state.duid)) {
                throw refuse('certsMissing',
                    'Packages are signed with this TV\'s own certificate pair, and none is ' +
                    'stored yet. Send one first — see `npm run certs`.');
            }

            const sign = await resigner();
            const { archive, device, files } = await sign(carried.archive);

            say.ok(`re-signed ${files} files for ${device || 'this television'}`);

            return { ...carried, archive };
        };

        const stageOnDisk = (carried) => {
            phase('staging', carried.identity.name || carried.identity.packageId);

            const stagedPath = installer.stage(carried.archive, carried.identity);

            say.ok(`staged ${size(carried.archive.length)} to ${stagedPath}`);

            return { ...carried, stagedPath };
        };

        const runInstaller = async (carried) => {
            phase('installing', carried.identity.name || carried.identity.packageId);

            const command = `shell:0 vd_appinstall ${carried.identity.packageId} ${carried.stagedPath}`;
            const began = Date.now();

            sdbSays.info(command);

            const result = await sdb.withSession({ log: (line) => sdbSays.info(line) }, (session) =>
                installer.run(session, carried.stagedPath, carried.identity.packageId));

            const verdict = String((result && result.output) || '')
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .pop();

            if (verdict) sdbSays.info(verdict);
            sdbSays.ok(`vd_appinstall finished in ${took(Date.now() - began)}`);

            return carried;
        };

        // Every catalog entry this install answers for: the one asked for, and any other that names the
        // same file — a collection's Alpha installed from the GitHub tab is still that entry's Alpha.
        const entriesFor = (carried) => {
            const origin = carried.origin || {};
            const listed = store.select('catalog') || [];

            const same = listed.filter((entry) => {
                if (origin.type === 'github' && entry.source.type === 'github') {
                    if (String(entry.source.ref).toLowerCase() !== String(origin.repo || '').toLowerCase()) return false;
                    if (!entry.source.asset) return true;
                    return entry.source.exact ? entry.source.asset === origin.asset : String(origin.asset).indexOf(entry.source.asset) !== -1;
                }

                return origin.type === 'url' && entry.source.type === 'url' && entry.source.ref === origin.url;
            }).map((entry) => entry.id);

            if (request.source === 'catalog' && same.indexOf(request.reference) === -1) same.push(request.reference);

            return same;
        };

        // Where this install came from, in words the phone can show beside the app: which list and which
        // repository, or the GitHub tab, a URL, an upload, a USB stick.
        const originOf = (carried) => {
            const origin = carried.origin || {};
            const listed = request.source === 'catalog'
                ? (store.select('catalog') || []).find((entry) => entry.id === request.reference) : null;
            const file = (value) => (value ? String(value).split('/').pop().slice(0, 120) : null);

            return {
                source: request.source,
                entry: listed ? listed.id : null,
                repository: listed ? listed.repository || 'official' : null,
                repo: origin.repo || null,
                asset: origin.asset || null,
                tag: origin.tag || null,
                host: origin.url ? (() => {
                    try { return new URL(origin.url).host; } catch (e) { return null; }
                })() : null,
                file: request.source === 'upload' || request.source === 'file' ? file(carried.name || request.reference) : null
            };
        };

        const recordOutcome = (carried) => {
            const { packageId, appId, name, version } = carried.identity;
            const at = new Date().toISOString();
            const kept = config.read();

            const previous = (kept.lastInstalled || [])
                .filter((entry) => entry.packageId !== packageId);

            const installedFrom = { ...(kept.installedFrom || {}) };

            entriesFor(carried).forEach((id) => {
                installedFrom[id] = { packageId, version, sha256: carried.sha256 || null, at };
            });

            // Bounded, newest kept: a television does not hold two hundred apps, and the file sits with the keys.
            const ids = Object.keys(installedFrom);
            if (ids.length > 200) {
                ids.sort((a, b) => String(installedFrom[b].at).localeCompare(String(installedFrom[a].at)))
                    .slice(200)
                    .forEach((id) => { delete installedFrom[id]; });
            }

            const origins = { ...(kept.origins || {}) };
            origins[packageId] = { ...originOf(carried), name: name || null, version: version || null,
                sha256: carried.sha256 || null, verified: Boolean(carried.verified), at };

            const recorded = Object.keys(origins);
            if (recorded.length > 200) {
                recorded.sort((a, b) => String(origins[b].at).localeCompare(String(origins[a].at)))
                    .slice(200)
                    .forEach((id) => { delete origins[id]; });
            }

            config.update({
                origins,
                lastInstalled: [{ packageId, appId, name, version, sha256: carried.sha256 || null, at }]
                    .concat(previous)
                    .slice(0, 20),
                installedFrom
            });

            return { packageId, appId, name, version, sha256: carried.sha256 || null, verified: Boolean(carried.verified) };
        };

        // Kept so the finally below can remove it whatever happened after it was written.
        let stagedPath = null;
        let failure = null;

        // Anything an install interrupted earlier left, once it is old enough.
        installer.sweep(undefined, { everything: false });

        try {
            const readied = await probeReadiness();
            const acquired = await acquirePackage(readied);
            const identified = await applyCustomization(readIdentity(acquired));
            const signed = await resign(identified);
            const staged = stageOnDisk(signed);
            stagedPath = staged.stagedPath;
            const installed = await runInstaller(staged);
            const outcome = recordOutcome(installed);

            // The icon the TV now shows for it, your own when you set one, kept for the phone's list.
            if (appIcons) appIcons.fromArchive(installed.archive, installed.identity);

            held.at('finishing');

            say.ok(`installed ${outcome.name || outcome.packageId} ${outcome.version || ''} in ${took(at())}`);

            return outcome;
        } catch (error) {
            failure = error;
            say.err(`install failed after ${took(at())}: ${error.code || 'internal'} — ${error.message}`);

            if (error.remedy) error.remedy.split('\n').forEach((line) => say.warn(line));

            // Certificates the TV rejected make every later attempt fail identically, so the next one re-mints.
            if (error.code === 'certRejected') {
                say.warn('clearing the stored certificates so the next attempt re-mints them');
                config.forgetCertificates();
            }

            throw error;
        } finally {
            // Left when the TV may still be installing it — the session dropped or timed out, so its outcome
            // is unknown — and swept up later, once it is old enough that nothing can be reading it.
            if (stagedPath && UNKNOWN_OUTCOME.indexOf(failure && failure.code) !== -1) {
                say.info(`left the staged copy for the TV to finish with; it is removed later`);
            } else if (stagedPath) {
                if (installer.unstage(stagedPath)) say.debug(`removed the staged copy ${stagedPath}`);
                else say.warn(`could not remove the staged copy ${stagedPath}`);
            }

            const high = held.highest();

            if (high.at) {
                say.info(`peak memory ${memory.describe(high)}, at ${high.at}` +
                    (high.peakRss ? `; process high-water ${size(high.peakRss)}` : ''));
            }

            store.update({ installing: false });
        }
    };

    return { install };
};

module.exports = { createInstaller };
