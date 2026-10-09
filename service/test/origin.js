'use strict';

// The socket's handshake rules: who may open it at all, before any PIN is offered.

const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

process.env.HOMEBREW_PORT = '8417';
process.env.HOMEBREW_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'homebrew-origin-'));
process.env.HOMEBREW_DEV_ORIGINS = 'http://localhost:5173';

const WebSocket = require('ws');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const silence = console.log;
console.log = () => {};
require('../src/main.js');
console.log = silence;

const attempt = (origin, headers = {}) => new Promise((resolve) => {
    const socket = new WebSocket('ws://127.0.0.1:8417', { ...(origin ? { origin } : {}), headers });
    socket.on('open', () => { socket.close(); resolve('open'); });
    socket.on('error', () => resolve('refused'));
});

setTimeout(async () => {
    check('a client with no origin — the CLI tools — connects', await attempt(null) === 'open', 'refused');
    check('so does this service’s own page', await attempt('http://127.0.0.1:8417') === 'open', 'refused');
    check('and a development server a developer named', await attempt('http://localhost:5173') === 'open', 'refused');
    check('but not any other page on localhost', await attempt('http://localhost:8099') === 'refused', 'opened');
    check('nor a sandboxed frame or data: page, which send the origin "null"', await attempt('null') === 'refused', 'opened');
    check('and, on loopback, the television’s packaged page', await attempt('file://') === 'open', 'refused');
    check('a web site elsewhere is refused before it can try a PIN', await attempt('https://example.com') === 'refused', 'opened');
    check('as is one claiming the TV’s address while asking for another host',
        await attempt('http://192.168.1.50:8417') === 'refused', 'opened');

    check('a page on a rebound name is refused even from loopback with a matching origin',
        await attempt('http://evil.example:8417', { host: 'evil.example:8417' }) === 'refused', 'opened');

    const pin = await new Promise((resolve) => {
        require('http').get({ host: '127.0.0.1', port: 8417, path: '/pin', headers: { host: 'evil.example:8417' } },
            (response) => { response.resume(); resolve(response.statusCode); }).on('error', () => resolve(0));
    });

    check('and so is a request for the PIN under a rebound name', pin === 403, `status ${pin}`);

    const own = await new Promise((resolve) => {
        require('http').get({ host: '127.0.0.1', port: 8417, path: '/pin' },
            (response) => { response.resume(); resolve(response.statusCode); }).on('error', () => resolve(0));
    });

    check('while the TV’s own page still reads it on 127.0.0.1', own === 200, `status ${own}`);

    const asked = (origin, path) => new Promise((resolve) => {
        require('http').get({ host: '127.0.0.1', port: 8417, path, headers: { origin } },
            (response) => { response.resume(); resolve(response.statusCode); }).on('error', () => resolve(0));
    });

    check('a web page the TV’s browser has open cannot read the PIN over loopback',
        await asked('https://evil.example', '/pin') === 403 && await asked('http://192.0.2.7', '/logs') === 403,
        'readable');

    check('the TV’s packaged page still can', await asked('file://', '/pin') === 200, 'refused');

    check('a sandboxed frame in the TV’s browser cannot either', await asked('null', '/pin') === 403, 'readable');

    const preflight = (origin) => new Promise((resolve) => {
        const r = require('http').request({ host: '127.0.0.1', port: 8417, path: '/install', method: 'OPTIONS',
            headers: { origin, host: '192.168.0.10:8417', 'access-control-request-headers': 'x-homebrew-pin' } },
        (response) => { response.resume(); resolve({ status: response.statusCode, allow: response.headers['access-control-allow-origin'] }); });
        r.on('error', () => resolve({ status: 0 }));
        r.end();
    });

    const foreign = await preflight('https://evil.example');
    const ownPage = await preflight('http://192.168.0.10:8417');

    check('no other web page is told it may send the PIN header',
        foreign.status === 403 && !foreign.allow, JSON.stringify(foreign));
    check('while the TV’s own page still may', ownPage.status === 204 && ownPage.allow === 'http://192.168.0.10:8417', JSON.stringify(ownPage));

    const pinNow = await new Promise((resolve) => {
        require('http').get({ host: '127.0.0.1', port: 8417, path: '/pin' }, (response) => {
            let body = '';
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => resolve(JSON.parse(body).pin));
        });
    });

    const withPin = (origin, given) => new Promise((resolve) => {
        require('http').get({ host: '127.0.0.1', port: 8417, path: '/packages',
            headers: { ...(origin ? { origin } : {}), 'x-homebrew-pin': given, host: '192.168.0.10:8417' } },
        (response) => { response.resume(); resolve(response.statusCode); }).on('error', () => resolve(0));
    });

    for (let i = 0; i < 8; i++) await withPin('https://evil.example', '000000');

    check('a web page sending wrong PINs does not lock out the device it is open on',
        await withPin(null, pinNow) !== 403, 'locked out');

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
}, 600);
