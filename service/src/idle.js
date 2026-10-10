'use strict';

// Stopping the service when it has nothing to do.
//
// The service starts with the television. With automatic updates off and phones let in only while the app is
// open, it has no work at all while the app is closed: it stops, and the memory it held goes back to the TV.
// Opening the app starts it again (the page launches it whenever nothing answers), which costs a second or two.
//
// A platform that brings a stopped service straight back (config.xml's auto-restart) would make that a loop.
// That is noticed — started again within RESTARTED_WITHIN of stopping, twice running — and remembered, and from
// then on the service stays up and waits quietly instead, as it did before.

const RESTARTED_WITHIN = 30 * 1000;
const LOOPS_TO_GIVE_UP = 2;

// How long a service started with the television waits for the app before stopping: the app may be
// opening anyway, and an update or a phone may need it first.
const AFTER_BOOT = { fallback: 90, min: 15, max: 3600 };

const bounded = (value, { fallback, min, max }) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
};

const createIdle = ({ config, access, store, log = null, now = () => Date.now(), exit = (code) => process.exit(code),
    timers = { setTimeout, clearTimeout }, onTv = true } = {}) => {
    const say = log ? log.on('svc') : null;
    const held = { timer: null, stopping: false };

    // What the last run said when it stopped, and whether this start came straight after.
    const recall = () => {
        const kept = config.read().idleStop || {};
        const quick = typeof kept.at === 'number' && now() - kept.at < RESTARTED_WITHIN;
        const loops = quick ? (kept.loops || 0) + 1 : 0;

        if (kept.at) config.update({ idleStop: { at: null, loops } });

        if (loops >= LOOPS_TO_GIVE_UP && !config.read().idleStopRestarts) {
            config.update({ idleStopRestarts: true });
            if (say) say.warn('this TV starts the service again as soon as it stops, so it stays up and waits instead');
        }
    };

    const wanted = () => {
        const kept = config.read();
        return onTv && kept.autoUpdate === 'off' && access.mode() === 'whileOpen' && kept.stopWhenIdle !== false &&
            !kept.idleStopRestarts;
    };

    const busy = () => Boolean(store.select('installing') || (store.select('updateRun') && store.select('updateRun').running));

    const stopNow = (why) => {
        if (held.stopping) return;
        held.stopping = true;

        if (say) say.info(`stopping: ${why} — opening Tizen Homebrew on the TV starts it again`);
        config.update({ idleStop: { at: now(), loops: (config.read().idleStop || {}).loops || 0 } });

        // The log line and the configuration are on disk before the process goes.
        const later = timers.setTimeout(() => exit(0), 200);
        if (later && later.unref) later.unref();
    };

    const consider = (why) => {
        if (!wanted() || access.isOpen()) return;

        if (busy()) {
            schedule(60 * 1000, why);
            return;
        }

        stopNow(why);
    };

    function schedule(ms, why) {
        if (held.timer) timers.clearTimeout(held.timer);
        held.timer = timers.setTimeout(() => {
            held.timer = null;
            consider(why);
        }, ms);
        if (held.timer && held.timer.unref) held.timer.unref();
    }

    const start = () => {
        recall();

        // Phone access closing is the moment the app has been away long enough.
        access.onClosed(() => consider('the app is closed and nothing needs the service'));

        // Started with the television and nobody opened the app.
        schedule(bounded(config.read().stopAfterBootSeconds, AFTER_BOOT) * 1000, 'nobody opened the app after the TV started');
    };

    return { start, consider, wanted, AFTER_BOOT };
};

module.exports = { createIdle, bounded, AFTER_BOOT, RESTARTED_WITHIN, LOOPS_TO_GIVE_UP };
