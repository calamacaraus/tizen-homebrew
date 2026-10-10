'use strict';

// When a phone may reach this service.
//
// The service starts with the television, so it can update apps on its own at night — that only ever
// connects out. Taking requests from the network is another matter: a port that answers all day is a
// PIN that can be guessed all day. By default, phones are let in while Tizen Homebrew is open on the TV,
// and for a while after it is closed, so a phone that paired at the TV can finish what it started:
//
//   'whileOpen'  phones only while the TV page is open, and GRACE after (the default)
//   'always'     phones at any time, as before
//
// The television itself, over loopback, is let in at any time: its own page, and the tools it runs.

const { isLoopback } = require('./hosts.js');

const MODES = ['whileOpen', 'always'];

// Minutes phones stay let in after the app closes: phoneAccessMinutes in the configuration, within these.
const MINUTES = { fallback: 15, min: 1, max: 120 };
const GRACE = MINUTES.fallback * 60 * 1000;

const minutesOf = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return MINUTES.fallback;
    return Math.min(MINUTES.max, Math.max(MINUTES.min, Math.round(number)));
};

const createAccess = ({ config, grace = null, now = () => Date.now(), log = null, timers = { setTimeout, clearTimeout } } = {}) => {
    const say = log ? log.on('auth') : null;

    // Open TV pages, by connection; and until when phones are let in after the last one closed.
    const pages = new Set();
    const held = { until: 0, timer: null, wasOpen: null };
    const closedListeners = [];

    const mode = () => (config.read().phoneAccess === 'always' ? 'always' : 'whileOpen');
    const graceMs = () => (grace === null ? minutesOf(config.read().phoneAccessMinutes) * 60 * 1000 : grace);

    const isOpen = () => mode() === 'always' || pages.size > 0 || now() < held.until;

    const allows = (request) => isLoopback(request && request.socket && request.socket.remoteAddress) || isOpen();

    const state = () => ({
        phoneAccess: mode(),
        phoneAccessMinutes: Math.round(graceMs() / 60000),
        phonesAllowed: isOpen(),
        // Only meaningful while the window runs down: with a page open, or always, there is no end.
        phonesUntil: mode() === 'whileOpen' && pages.size === 0 && now() < held.until ? new Date(held.until).toISOString() : null
    });

    const notifyIfClosed = () => {
        if (isOpen()) return;
        closedListeners.slice().forEach((listener) => {
            try { listener(); } catch (e) { if (say) say.warn(`closing phone access: ${e.message}`); }
        });
    };

    const arm = () => {
        if (held.timer) timers.clearTimeout(held.timer);
        held.timer = null;

        if (mode() !== 'whileOpen' || pages.size > 0) return;

        const left = held.until - now();
        if (left <= 0) {
            notifyIfClosed();
            return;
        }

        held.timer = timers.setTimeout(() => {
            held.timer = null;
            if (say && !isOpen()) say.info('phone access closed — open Tizen Homebrew on the TV to let phones in again');
            notifyIfClosed();
        }, left + 50);
        if (held.timer && held.timer.unref) held.timer.unref();
    };

    // Phones in for the grace period from now: the app was just opened, or its page just closed.
    const extend = () => {
        held.until = Math.max(held.until, now() + graceMs());
        arm();
    };

    const pageOpened = (id) => {
        pages.add(id);
        held.until = 0;
        arm();
    };

    const pageClosed = (id) => {
        if (!pages.delete(id)) return;
        if (pages.size === 0) extend();
    };

    // A launch reaching a running service: the TV page is about to connect, so phones may start now.
    const launched = () => extend();

    // A setting changed: an 'always' turned back to 'whileOpen' starts the grace period, not a shutdown.
    const changed = () => {
        if (mode() === 'whileOpen' && pages.size === 0) extend();
        else arm();
    };

    const onClosed = (listener) => closedListeners.push(listener);

    return { allows, isOpen, state, mode, pageOpened, pageClosed, launched, changed, onClosed, MODES };
};

module.exports = { createAccess, minutesOf, MODES, MINUTES, GRACE };
