'use strict';

// Phones reach the service while the app is open on the TV, and a while after; the TV itself always.

const os = require('os');
const fs = require('fs');
const http = require('http');

const PORT = Number(process.env.HOMEBREW_PORT) || 8398;
process.env.HOMEBREW_PORT = String(PORT);
process.env.HOMEBREW_CONFIG_DIR = fs.mkdtempSync(`${os.tmpdir()}/homebrew-access-`);

const WebSocket = require('ws');
const { createAccess, GRACE } = require('../src/http/access.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const from = (remoteAddress) => ({ socket: { remoteAddress } });
const PHONE = from('192.0.2.20');
const TV = from('127.0.0.1');

const fakeTime = () => {
    const clock = { now: 1000000, timers: [] };
    return {
        clock,
        now: () => clock.now,
        timers: {
            setTimeout: (run, ms) => {
                const timer = { at: clock.now + ms, run };
                clock.timers.push(timer);
                return timer;
            },
            clearTimeout: (timer) => { clock.timers = clock.timers.filter((one) => one !== timer); }
        },
        pass: (ms) => {
            clock.now += ms;
            const due = clock.timers.filter((timer) => timer.at <= clock.now);
            clock.timers = clock.timers.filter((timer) => timer.at > clock.now);
            due.forEach((timer) => timer.run());
        }
    };
};

const unit = () => {
    const stored = { phoneAccess: 'whileOpen' };
    const config = { read: () => stored };
    const time = fakeTime();
    const access = createAccess({ config, now: time.now, timers: time.timers });
    const closings = { count: 0 };
    access.onClosed(() => { closings.count += 1; });

    check('started with the TV, a phone is not let in until the app is opened', !access.allows(PHONE) && access.allows(TV),
        JSON.stringify(access.state()));

    access.pageOpened('page');
    check('while the TV page is open, it is', access.allows(PHONE) && access.state().phonesUntil === null,
        JSON.stringify(access.state()));

    access.pageClosed('page');
    time.pass(GRACE - 60000);
    check('and for a while after it closes, with the time it ends said', access.allows(PHONE) &&
        Date.parse(access.state().phonesUntil) === 1000000 + GRACE, JSON.stringify(access.state()));

    time.pass(120000);
    check('then not, and those still connected are let go', !access.allows(PHONE) && closings.count === 1,
        `${access.allows(PHONE)} ${closings.count}`);

    check('the TV itself is let in at any time', access.allows(TV) && access.allows(from('::ffff:127.0.0.1')), 'refused');

    access.launched();
    check('opening the app lets phones in at once, before its page connects', access.allows(PHONE), 'refused');
    time.pass(GRACE + 1000);

    access.pageOpened('a');
    access.pageOpened('b');
    access.pageClosed('a');
    check('two pages open, one closed: still open, with no end', access.allows(PHONE) && access.state().phonesUntil === null,
        JSON.stringify(access.state()));
    access.pageClosed('b');
    access.pageClosed('b');
    time.pass(GRACE + 1000);
    check('a page closed twice counts once', !access.allows(PHONE), 'open');

    stored.phoneAccess = 'always';
    access.changed();
    check('set to always, a phone is let in with the app closed', access.allows(PHONE) && access.state().phoneAccess === 'always',
        JSON.stringify(access.state()));

    stored.phoneAccess = 'whileOpen';
    access.changed();
    check('turned back, the phone that changed it is not cut off there and then', access.allows(PHONE) &&
        access.state().phonesUntil !== null, JSON.stringify(access.state()));

    stored.phoneAccess = 'nonsense';
    check('anything stored that is not "always" counts as the safer one', access.mode() === 'whileOpen', access.mode());
};

const lanAddress = () => Object.values(os.networkInterfaces()).flat()
    .filter((entry) => entry && (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)
    .map((entry) => entry.address)[0];

const get = (address, path) => new Promise((resolve) => {
    http.get({ host: address, port: PORT, path, timeout: 4000 }, (res) => {
        const read = { body: '' };
        res.on('data', (chunk) => { read.body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: read.body, type: res.headers['content-type'] }));
    }).on('error', (error) => resolve({ status: 0, body: error.message }));
});

const socketFrom = (address) => new Promise((resolve) => {
    const socket = new WebSocket(`ws://${address}:${PORT}`);
    socket.on('open', () => resolve({ socket, opened: true }));
    socket.on('error', () => resolve({ socket, opened: false }));
});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const endToEnd = async () => {
    const address = lanAddress();
    if (!address) {
        check('(no network address here to stand in for a phone; the end-to-end part is skipped)', true, '');
        return;
    }

    require('../src/main.js').start();
    await settle(300);

    const page = await get(address, '/');
    check('a phone opening the page with the app closed is told to open it on the TV, and looks again by itself',
        page.status === 403 && /Open Tizen Homebrew on the TV/.test(page.body) && /http-equiv="refresh"/.test(page.body),
        `${page.status} ${page.body.slice(0, 80)}`);

    const asked = await get(address, '/logs');
    check('and anything else it asks for is refused with the reason, before any PIN is looked at',
        asked.status === 403 && /phoneAccessClosed/.test(asked.body), `${asked.status} ${asked.body}`);

    const early = await socketFrom(address);
    check('a socket from a phone is not opened either, so there is no PIN to guess', !early.opened, 'opened');
    early.socket.terminate();

    const tv = await socketFrom('127.0.0.1');
    check('the TV page connects as ever', tv.opened, 'refused');
    await settle(100);

    const now = await get(address, '/health');
    check('and while it is open, phones are let in', now.status === 200, `${now.status} ${now.body}`);

    const phone = await socketFrom(address);
    check('sockets too', phone.opened, 'refused');

    phone.socket.terminate();
    tv.socket.close();
};

(async () => {
    try {
        unit();
        await endToEnd();
    } catch (error) {
        check('harness', false, error.stack);
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    fs.rmSync(process.env.HOMEBREW_CONFIG_DIR, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
})();
