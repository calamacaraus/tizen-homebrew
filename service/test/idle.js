'use strict';

// The service stops when it has nothing to do, and stays up on a TV that would only start it again.

const { createIdle, bounded, AFTER_BOOT, RESTARTED_WITHIN } = require('../src/idle.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const make = (stored, { open = false, busy = false } = {}) => {
    const clock = { now: 5000000, timers: [] };
    const config = {
        read: () => stored,
        update: (patch) => Object.assign(stored, patch)
    };
    const closedListeners = [];
    const access = {
        mode: () => (stored.phoneAccess === 'always' ? 'always' : 'whileOpen'),
        isOpen: () => open,
        onClosed: (listener) => closedListeners.push(listener)
    };
    const store = { select: (key) => (key === 'installing' ? busy : null) };
    const exits = [];

    const idle = createIdle({
        config, access, store,
        now: () => clock.now,
        exit: (code) => exits.push(code),
        timers: {
            setTimeout: (run, ms) => {
                const timer = { at: clock.now + ms, run };
                clock.timers.push(timer);
                return timer;
            },
            clearTimeout: (timer) => { clock.timers = clock.timers.filter((one) => one !== timer); }
        }
    });

    const pass = (ms) => {
        clock.now += ms;
        const due = clock.timers.filter((timer) => timer.at <= clock.now);
        clock.timers = clock.timers.filter((timer) => timer.at > clock.now);
        due.forEach((timer) => timer.run());
    };

    return { idle, exits, pass, stored, clock, closed: () => closedListeners.forEach((listener) => listener()),
        set: (changes) => { if ('open' in changes) open = changes.open; if ('busy' in changes) busy = changes.busy; } };
};

const QUIET = { autoUpdate: 'off', phoneAccess: 'whileOpen', stopAfterBootSeconds: 90 };

{
    const t = make({ ...QUIET });
    t.idle.start();
    t.pass(89 * 1000);
    check('started with the TV and the app not opened, it waits a while first', t.exits.length === 0, t.exits.join());
    t.pass(2000);
    t.pass(300);
    check('then stops, and says when it did', t.exits.join() === '0' && typeof t.stored.idleStop.at === 'number',
        JSON.stringify(t.stored.idleStop));
}

{
    const t = make({ ...QUIET }, { open: true });
    t.idle.start();
    t.pass(10 * 60 * 1000);
    check('not while the app is open on the TV', t.exits.length === 0, t.exits.join());

    t.set({ open: false });
    t.closed();
    t.pass(300);
    check('and when phone access closes after the app, it stops', t.exits.join() === '0', t.exits.join());
}

{
    const t = make({ ...QUIET }, { busy: true });
    t.idle.start();
    t.pass(91 * 1000);
    check('not in the middle of an install', t.exits.length === 0, t.exits.join());
    t.set({ busy: false });
    t.pass(61 * 1000);
    t.pass(300);
    check('but once it is done', t.exits.join() === '0', t.exits.join());
}

['check', 'install'].forEach((mode) => {
    const t = make({ ...QUIET, autoUpdate: mode });
    t.idle.start();
    t.pass(3600 * 1000);
    check(`with automatic updates on ("${mode}") it stays, since it has work to do`, t.exits.length === 0, t.exits.join());
});

{
    const always = make({ ...QUIET, phoneAccess: 'always' });
    always.idle.start();
    always.pass(3600 * 1000);

    const kept = make({ ...QUIET, stopWhenIdle: false });
    kept.idle.start();
    kept.pass(3600 * 1000);

    check('nor with phones let in always, or with stopping turned off', always.exits.length === 0 && kept.exits.length === 0,
        `${always.exits} ${kept.exits}`);
}

{
    // Stopped a moment ago, twice running: the platform is starting it again each time.
    const stored = { ...QUIET, idleStop: { at: 5000000 - 5000, loops: 1 } };
    const t = make(stored);
    t.idle.start();
    t.pass(3600 * 1000);
    check('on a TV that starts it again at once, it notices and stays up instead of looping',
        stored.idleStopRestarts === true && t.exits.length === 0, JSON.stringify(stored));

    const once = { ...QUIET, idleStop: { at: 5000000 - 5000, loops: 0 } };
    const u = make(once);
    u.idle.start();
    check('one quick start is not yet a loop', !once.idleStopRestarts && once.idleStop.loops === 1, JSON.stringify(once));

    const later = { ...QUIET, idleStop: { at: 5000000 - RESTARTED_WITHIN - 1000, loops: 1 } };
    const v = make(later);
    v.idle.start();
    check('and a start long after a stop, like the next evening, counts from nothing', later.idleStop.loops === 0 &&
        !later.idleStopRestarts, JSON.stringify(later));
}

check('a stored wait out of bounds, or not a number, is held within them',
    bounded(1, AFTER_BOOT) === AFTER_BOOT.min && bounded(1e9, AFTER_BOOT) === AFTER_BOOT.max &&
    bounded('soon', AFTER_BOOT) === AFTER_BOOT.fallback && bounded(120, AFTER_BOOT) === 120, 'unbounded');

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
