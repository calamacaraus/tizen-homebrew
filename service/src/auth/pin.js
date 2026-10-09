'use strict';

const { randomBytes, timingSafeEqual } = require('crypto');

const DIGITS = 6;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

// Not a secret: a build pushed at a television every few minutes should not have to be read off its screen.
const DEVELOPER_PIN = '0'.repeat(DIGITS);

const generate = () => {
    const ceiling = 10 ** DIGITS;

    const draw = () => {
        // Rejection sampling: a modulus of a random 32-bit value would make the low PINs likelier.
        const limit = Math.floor(0xffffffff / ceiling) * ceiling;
        for (;;) {
            const value = randomBytes(4).readUInt32BE(0);
            if (value < limit) return value % ceiling;
        }
    };

    return String(draw()).padStart(DIGITS, '0');
};

const matches = (attempt, pin) => {
    const given = Buffer.from(String(attempt ?? ''));
    const expected = Buffer.from(pin);

    // timingSafeEqual needs equal lengths, so length is compared first.
    if (given.length !== expected.length) return false;

    return timingSafeEqual(given, expected);
};

const fresh = () => ({ failures: 0, lockedUntil: 0 });

const remaining = (lockout, now = Date.now()) => Math.max(0, lockout.lockedUntil - now);

const isLocked = (lockout, now = Date.now()) => remaining(lockout, now) > 0;

const recordFailure = (lockout, now = Date.now()) => {
    const failures = lockout.failures + 1;

    // Reaching the limit starts the timer and resets the count, so each lockout has to be earned again.
    return failures >= MAX_ATTEMPTS
        ? { failures: 0, lockedUntil: now + LOCKOUT_MS }
        : { failures, lockedUntil: lockout.lockedUntil };
};

const recordSuccess = () => fresh();

// Failures counted per address, so one device on the network that keeps guessing locks out itself, not
// every phone in the house. Many addresses guessing together — more than ALL_ATTEMPTS failures within a
// lockout's length — lock out everyone but the television itself, which reads the code off its own screen.
const ALL_ATTEMPTS = 30;
const TRACKED = 256;

// A device that has given the right PIN is remembered for this long: many addresses guessing together do
// not lock out the phones that already paired, only the ones that never have.
const KNOWN_FOR = 30 * 24 * 60 * 60 * 1000;
const KNOWN = 64;

const createGuard = ({ now = () => Date.now() } = {}) => {
    const byAddress = new Map();
    const known = new Map();
    let recent = [];

    const stateOf = (address) => byAddress.get(address) || fresh();

    const crowded = () => {
        const since = now() - LOCKOUT_MS;
        recent = recent.filter((at) => at > since);
        return recent.length >= ALL_ATTEMPTS;
    };

    // `local`: the television itself, never locked out by what other devices do.
    const check = (address, local = false) => {
        const own = stateOf(address);

        if (isLocked(own, now())) return { locked: true, remaining: remaining(own, now()) };
        const trusted = local || (known.has(address) && now() - known.get(address) < KNOWN_FOR);
        if (!trusted && crowded()) return { locked: true, remaining: LOCKOUT_MS - (now() - recent[0]) };

        return { locked: false };
    };

    const failed = (address) => {
        const next = recordFailure(stateOf(address), now());

        // Re-inserted, so the map's order is oldest failure first.
        byAddress.delete(address);
        byAddress.set(address, next);
        recent.push(now());

        // The oldest address forgotten first, so a sweep of the whole network cannot grow this without end.
        while (byAddress.size > TRACKED) byAddress.delete(byAddress.keys().next().value);
    };

    const succeeded = (address) => {
        byAddress.delete(address);
        known.delete(address);
        known.set(address, now());
        while (known.size > KNOWN) known.delete(known.keys().next().value);
    };

    return { check, failed, succeeded };
};

module.exports = {
    createGuard, ALL_ATTEMPTS,
    generate, matches, fresh, remaining, isLocked, recordFailure, recordSuccess,
    DIGITS, MAX_ATTEMPTS, LOCKOUT_MS, DEVELOPER_PIN
};
