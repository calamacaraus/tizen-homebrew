'use strict';

// Updating without anyone at the phone: "update all" from the phone or the television's own screen, and
// a daily look on its own when the setting allows. Everything goes through the one installer, one app at
// a time, so this can never run two installs into sdbd at once.
//
//   autoUpdate 'off'      nothing happens unasked
//              'check'    look once a day, write what is newer into the log and onto the TV screen
//              'install'  look once a day and install what is newer
//
// A rebuild at the same version is never installed unasked; only "update all" with includeRebuilt does.

const versions = require('./versions.js');

const FIRST_LOOK = 5 * 60 * 1000;
const EVERY = 24 * 60 * 60 * 1000;

// How long a run waits for an install someone started from the phone to finish before giving up on it.
const PATIENCE = 15 * 60 * 1000;
const POLL = 1000;

// Itself last: replacing this app restarts the service, which would end the run partway.
const SELF = 'GJBBYNLkgP';

const quiet = { info: () => {}, ok: () => {}, warn: () => {}, err: () => {}, debug: () => {} };

const createAutoUpdate = ({ library, updates, installer, config, store, log, broadcast = () => {},
    timers = { setTimeout, setInterval, clearTimeout, clearInterval } }) => {
    const say = log ? log.on('upd') : quiet;

    let running = null;

    const progress = (state) => {
        store.update({ updateRun: state });
        broadcast('updateRun', state);
    };

    // The catalog marked fresh: collections asked again, single repositories asked GitHub one by one.
    const survey = async () => {
        const listed = await library.fetch({ refresh: 'collections' });

        store.update({ catalog: listed.entries, catalogStale: listed.stale });

        const marked = await updates.check(listed.entries);

        return { listed, marked };
    };

    // One install per package: the same app can be listed twice (the built-in catalog and a collection that
    // also carries it), and installing both would leave whichever ran last — possibly the older.
    const pending = (marked, includeRebuilt) => {
        const chosen = {};

        marked
            .filter((entry) => entry.update || (includeRebuilt && entry.rebuilt))
            .forEach((entry) => {
                const key = entry.packageId || `entry:${entry.id}`;
                const held = chosen[key];

                const better = !held ||
                    versions.compare(entry.available, held.available) === 1 ||
                    (versions.compare(entry.available, held.available) !== -1 && !entry.collection && held.collection);

                if (better) chosen[key] = entry;
            });

        return Object.keys(chosen).map((key) => chosen[key])
            .sort((a, b) => (a.packageId === SELF) - (b.packageId === SELF));
    };

    // An install the phone started finishes first; this run takes its turn after it rather than failing.
    const idle = async () => {
        const began = Date.now();

        while (store.select('installing')) {
            if (Date.now() - began > PATIENCE) return false;
            await new Promise((resolve) => timers.setTimeout(resolve, POLL));
        }

        return true;
    };

    const run = ({ trigger = 'asked', includeRebuilt = false, install = true } = {}) => {
        if (running) return running;

        running = (async () => {
            const updated = [];
            const failed = [];

            try {
                const { marked } = await survey();
                const queue = pending(marked, includeRebuilt);

                say.info(`${trigger === 'asked' ? '' : 'scheduled: '}${queue.length
                    ? `${queue.length} to update — ${queue.map((entry) => entry.name).join(', ')}`
                    : 'everything is up to date'}`);

                if (!install) {
                    const result = { available: queue.map((entry) => entry.name), updated, failed };
                    config.update({ lastUpdateCheck: new Date().toISOString(), lastUpdateResult: result });
                    progress({ running: false, index: queue.length, total: queue.length, updated, failed,
                        available: result.available, trigger });
                    return result;
                }

                for (let index = 0; index < queue.length; index += 1) {
                    const entry = queue[index];

                    progress({ running: true, index, total: queue.length, current: entry.name, updated, failed, trigger });

                    if (!(await idle())) {
                        failed.push({ name: entry.name, code: 'busy', message: 'Another install did not finish in time.' });
                        break;
                    }

                    try {
                        await installer.install({ source: 'catalog', reference: entry.id });
                        updates.changed();
                        updated.push(entry.name);
                        say.ok(`updated ${entry.name}`);
                    } catch (error) {
                        failed.push({ name: entry.name, code: error.code || 'internal', message: error.message });
                        say.warn(`${entry.name} did not update: ${error.message}`);

                        // A television that cannot install at all will not install the next one either.
                        if (['debugModeOff', 'sdbUnreachable', 'sdbRefused', 'certsMissing', 'busy'].indexOf(error.code) !== -1) break;
                    }
                }

                const result = { available: [], updated, failed: failed.map((entry) => entry.name) };
                config.update({ lastUpdateCheck: new Date().toISOString(), lastUpdateResult: result });
                progress({ running: false, index: queue.length, total: queue.length, updated, failed, trigger });

                return result;
            } catch (error) {
                say.warn(`could not look for updates: ${error.message}`);
                progress({ running: false, index: 0, total: 0, updated, failed, error: error.message, trigger });
                throw error;
            } finally {
                running = null;
            }
        })();

        return running;
    };

    const tick = () => {
        const mode = config.read().autoUpdate;
        if (mode !== 'check' && mode !== 'install') return;

        // An install asked for from the phone is left to finish; tomorrow comes round anyway.
        if (store.select('installing')) return;

        run({ trigger: 'scheduled', install: mode === 'install' }).catch(() => {});
    };

    let first = null;
    let daily = null;

    const start = () => {
        first = timers.setTimeout(tick, FIRST_LOOK);
        daily = timers.setInterval(tick, EVERY);
    };

    const stop = () => {
        if (first) timers.clearTimeout(first);
        if (daily) timers.clearInterval(daily);
    };

    const settings = () => {
        const kept = config.read();
        return { autoUpdate: kept.autoUpdate || 'off', lastCheck: kept.lastUpdateCheck, lastResult: kept.lastUpdateResult };
    };

    return { run, tick, start, stop, settings, isRunning: () => Boolean(running) };
};

module.exports = { createAutoUpdate, FIRST_LOOK, EVERY, PATIENCE };
