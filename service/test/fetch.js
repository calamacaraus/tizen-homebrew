'use strict';

const http = require('http');

const fetch = require('../src/remote/fetch.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const asked = [];
const realRequest = http.request;

http.request = function (target, options, callback) {
    asked.push(options);
    return realRequest.call(this, target, options, callback);
};

const listen = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

const main = async () => {
    {
        const { server, port } = await listen((request, response) => response.end('{"ok":true}'));

        await fetch.getJson(`http://127.0.0.1:${port}/`);

        check('a request carries its timeout in the options, not only on the socket',
            asked.length === 1 && asked[0].timeout === fetch.DEFAULT_TIMEOUT,
            JSON.stringify(asked[0]));

        asked.length = 0;
        await fetch.request(`http://127.0.0.1:${port}/`, { timeout: 4321 });

        check('a caller-supplied timeout is the one that travels',
            asked[0].timeout === 4321, JSON.stringify(asked[0]));

        server.close();
    }

    {
        const { server, port } = await listen((request, response) => {
            if (request.url === '/from') {
                response.writeHead(302, { location: `http://127.0.0.1:${port}/to` });
                return response.end();
            }
            response.end('done');
        });

        asked.length = 0;
        await fetch.request(`http://127.0.0.1:${port}/from`, { timeout: 5555 });

        check('a redirect carries the timeout to the next request',
            asked.length === 2 && asked.every((options) => options.timeout === 5555),
            JSON.stringify(asked));

        server.close();
    }

    {
        const held = [];
        const { server, port } = await listen((request) => held.push(request));

        const began = Date.now();
        const error = await fetch.request(`http://127.0.0.1:${port}/`, { timeout: 300 })
            .then(() => null, (failure) => failure);
        const elapsed = Date.now() - began;

        check('a server that never answers fails as a timeout, in the time given',
            error && /Timed out after 300ms/.test(error.message) && elapsed >= 300 && elapsed < 3000,
            `${error && error.message} after ${elapsed}ms`);

        server.close();
        held.forEach((request) => request.destroy());
    }

    {
        const { server, port } = await listen((request, response) => {
            if (request.url === '/declared') {
                response.writeHead(200, { 'content-length': String(10 * 1024) });
                return response.end(Buffer.alloc(10 * 1024));
            }

            // No length declared: only counting what arrives can stop it.
            response.write(Buffer.alloc(8 * 1024));
            response.end(Buffer.alloc(8 * 1024));
        });

        const declared = await fetch.getBuffer(`http://127.0.0.1:${port}/declared`, { maxBytes: 4096 })
            .then(() => null, (failure) => failure);

        check('a body declared over the limit is refused before it is read',
            declared && declared.code === 'tooLarge', declared && declared.message);

        const streamed = await fetch.getBuffer(`http://127.0.0.1:${port}/streamed`, { maxBytes: 4096 })
            .then(() => null, (failure) => failure);

        check('and one that only turns out to be too large is stopped as it arrives',
            streamed && streamed.code === 'tooLarge', streamed && streamed.message);

        const fits = await fetch.getBuffer(`http://127.0.0.1:${port}/declared`, { maxBytes: 64 * 1024 });

        check('while a body under the limit arrives whole', fits.length === 10 * 1024, String(fits.length));

        server.close();
    }

    {
        const { server, port } = await listen((request, response) => {
            response.writeHead(302, { location: `http://127.0.0.1:${port}/plain` });
            response.end();
        });

        const refused = await fetch.request(`http://127.0.0.1:${port}/`, { httpsOnly: true })
            .then(() => null, (failure) => failure);

        check('a download held to https is not followed anywhere in the clear',
            refused && /only https/.test(refused.message), refused && refused.message);

        server.close();
    }

    {
        const { server, port } = await listen((request, response) => {
            response.writeHead(200, { 'content-length': '5000' });
            response.write(Buffer.alloc(1000));
            setTimeout(() => response.socket.destroy(), 20);
        });

        const cut = await fetch.getBuffer(`http://127.0.0.1:${port}/`)
            .then((body) => ({ body }), (failure) => ({ failure }));

        check('a download the server cuts short is a failure, not a short package',
            cut.failure && /cut off|stopped at|Response failed|ECONNRESET/.test(cut.failure.message),
            cut.failure ? cut.failure.message : `resolved with ${cut.body.length} bytes`);

        server.close();
    }

    http.request = realRequest;

    {
        // A server that sends a byte every 50ms, never idle long enough to time out, and never finishing.
        const { server, port } = await listen((request, response) => {
            response.writeHead(200, { 'content-length': 1000000 });
            const drip = setInterval(() => response.write('x'), 50);
            response.on('close', () => clearInterval(drip));
        });

        const began = Date.now();
        const outcome = await fetch.request(`http://127.0.0.1:${port}/slow`, { timeout: 1000, deadline: 600 })
            .then(() => 'finished', (error) => error.message);

        check('a download that trickles in forever is given up at its deadline',
            /did not finish in time/.test(outcome) && Date.now() - began < 1500, `${outcome} after ${Date.now() - began}ms`);

        server.close();
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

main().catch((error) => {
    console.error('\nHarness error:', error.message);
    process.exit(1);
});
