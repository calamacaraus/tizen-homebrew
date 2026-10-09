'use strict';

// The socket's handshake rules: who may open it at all, before any PIN is offered.

const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

process.env.HOMEBREW_PORT = '8417';
process.env.HOMEBREW_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'homebrew-origin-'));

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
    check('and a development server on localhost', await attempt('http://localhost:5173') === 'open', 'refused');
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

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
}, 600);
