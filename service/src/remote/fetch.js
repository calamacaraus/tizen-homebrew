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
const request = (url, options = {}) => {
    const {
        method = 'GET', headers = {}, body, timeout = DEFAULT_TIMEOUT, redirectsLeft = MAX_REDIRECTS,
        // `maxBytes` is enforced as the body arrives, not after; `httpsOnly` holds every redirect to https,
        // so a package asked for over TLS cannot be handed over in the clear by a hop along the way.
        maxBytes = Infinity, httpsOnly = false
    } = options;

    return new Promise((resolve, reject) => {
        const target = new URL(url);

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
                return resolve(request(next, { ...options, redirectsLeft: redirectsLeft - 1 }));
            }

            const declared = Number(response.headers['content-length']);

            if (declared > maxBytes) {
                response.destroy();
                return reject(tooLarge(url, maxBytes));
            }

            const chunks = [];
            let received = 0;
            let finished = false;

            response.on('data', (chunk) => {
                received += chunk.length;

                if (received > maxBytes) {
                    finished = true;
                    response.destroy();
                    return reject(tooLarge(url, maxBytes));
                }

                chunks.push(chunk);
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

                resolve({
                    status: response.statusCode,
                    headers: response.headers,
                    body: Buffer.concat(chunks)
                });
            });

            response.on('error', (error) => {
                if (finished) return;
                finished = true;
                failWith(`Response failed: ${error.message}`);
            });
        };

        const outgoing = transport.request(target, { method, headers, timeout }, collect);

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
    const { status, body } = await request(url, { maxBytes: MAX_JSON, ...options });

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
