'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 15000;

const MAX_REDIRECTS = 5;

// What any one JSON answer may weigh: a catalog or a release listing is kilobytes, and nothing this
// service asks for should be able to fill a television's memory by answering at length.
const MAX_JSON = 4 * 1024 * 1024;

const tooLarge = (url, limit) => Object.assign(
    new Error(`${url} is larger than the ${Math.round(limit / (1024 * 1024))}MB this will download`),
    { code: 'tooLarge', url });

// A hundred lines in place of node-fetch, which cost 308KB of the bundle. Node 12 has no global fetch.
const DEFAULT_DEADLINE = 30 * 60 * 1000;

const request = (url, options = {}) => {
    const {
        method = 'GET', headers = {}, body, timeout = DEFAULT_TIMEOUT, redirectsLeft = MAX_REDIRECTS,
        // `maxBytes` is enforced as the body arrives, not after; `httpsOnly` holds every redirect to https,
        // so a package asked for over TLS cannot be handed over in the clear by a hop along the way.
        maxBytes = Infinity, httpsOnly = false,
        // The whole request, redirects and body included: `timeout` is only how long it may sit idle, and a
        // server sending a byte now and then would otherwise hold an install open for hours.
        deadlineAt = Date.now() + (options.deadline || DEFAULT_DEADLINE)
    } = options;

    return new Promise((outerResolve, outerReject) => {
        let target;

        try {
            target = new URL(url);
        } catch (error) {
            return outerReject(Object.assign(new Error(`Not a URL: ${url}`), { url, code: 'badMessage' }));
        }

        let outgoing = null;

        const overall = setTimeout(() => {
            if (outgoing) outgoing.destroy();
            outerReject(Object.assign(new Error(`Gave up on ${url}: it did not finish in time`), { url }));
        }, Math.max(0, deadlineAt - Date.now()));

        const resolve = (value) => { clearTimeout(overall); outerResolve(value); };
        const reject = (error) => { clearTimeout(overall); outerReject(error); };

        if (httpsOnly && target.protocol !== 'https:') {
            return reject(Object.assign(new Error(`Refusing ${url}: only https is followed`), { url, code: 'badMessage' }));
        }

        const transport = target.protocol === 'https:' ? https : http;

        const failWith = (message) => reject(Object.assign(new Error(message), { url }));

        const collect = (response) => {
            const isRedirect = response.statusCode >= 300 && response.statusCode < 400 && response.headers.location;

            if (isRedirect) {
                response.resume(); // Drain, or the socket is held open.

                if (redirectsLeft <= 0) return failWith(`Too many redirects from ${url}`);

                const next = new URL(response.headers.location, url).toString();
                return request(next, { ...options, redirectsLeft: redirectsLeft - 1, deadlineAt }).then(resolve, reject);
            }

            const declared = Number(response.headers['content-length']);

            if (declared > maxBytes) {
                response.destroy();
                return reject(tooLarge(url, maxBytes));
            }

            const chunks = [];
            let received = 0;
            let finished = false;

            // With its length known, a download is written into one buffer of that size as it arrives, rather
            // than gathered in pieces and copied once more at the end: a 150MB package needs 150MB, not 300.
            let whole = declared > 0 && !response.headers['content-encoding'] ? Buffer.allocUnsafe(declared) : null;

            response.on('data', (chunk) => {
                if (received + chunk.length > maxBytes) {
                    finished = true;
                    whole = null;
                    response.destroy();
                    return reject(tooLarge(url, maxBytes));
                }

                if (whole && received + chunk.length <= whole.length) {
                    chunk.copy(whole, received);
                } else {
                    // More than it declared: gathered as pieces from here, with what came before.
                    if (whole) {
                        chunks.push(whole.slice(0, received));
                        whole = null;
                    }
                    chunks.push(chunk);
                }

                received += chunk.length;
            });

            // Node 12 can end a response the server cut short as though it were whole; a declared length
            // that did not arrive is a failed download, not a short package to fail on later.
            response.on('aborted', () => {
                if (finished) return;
                finished = true;
                failWith(`The download from ${url} was cut off`);
            });

            response.on('end', () => {
                if (finished) return;
                finished = true;

                if (declared > 0 && received < declared && !response.headers['content-encoding']) {
                    return failWith(`The download from ${url} stopped at ${received} of ${declared} bytes`);
                }

                const body = whole ? whole.slice(0, received) : Buffer.concat(chunks);
                whole = null;

                resolve({ status: response.statusCode, headers: response.headers, body });
            });

            response.on('error', (error) => {
                if (finished) return;
                finished = true;
                failWith(`Response failed: ${error.message}`);
            });
        };

        outgoing = transport.request(target, { method, headers, timeout }, collect);

        outgoing.setTimeout(timeout, () => {
            outgoing.destroy();
            failWith(`Timed out after ${timeout}ms: ${url}`);
        });

        outgoing.on('error', (error) => failWith(`${error.code || 'Request failed'}: ${url}`));

        if (body) outgoing.write(body);
        outgoing.end();
    });
};

const getJson = async (url, options = {}) => {
    const { status, body } = await request(url, { maxBytes: MAX_JSON, deadline: 2 * 60 * 1000, ...options });

    if (status < 200 || status >= 300) {
        throw Object.assign(new Error(`${url} returned ${status}`), { status });
    }

    try {
        return JSON.parse(body.toString('utf8'));
    } catch (e) {
        throw new Error(`${url} did not return JSON`);
    }
};

const getBuffer = async (url, options = {}) => {
    const { status, body } = await request(url, options);

    if (status < 200 || status >= 300) {
        throw Object.assign(new Error(`${url} returned ${status}`), { status });
    }

    return body;
};

module.exports = { request, getJson, getBuffer, MAX_REDIRECTS, DEFAULT_TIMEOUT, MAX_JSON };
