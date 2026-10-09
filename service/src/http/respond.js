'use strict';

const MAX_BODY = 200 * 1024 * 1024;
const IDLE_BODY = 30 * 1000;

// The phone UI pairs and installs, so it is not to be framed by another page (a click on it could be
// borrowed), and nothing it serves is to be sniffed into a type it was not sent as.
const HARDENED = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer'
};

// No CORS header here: router.js gives one to trusted origins only.
const json = (response, value, status = 200) => {
    const payload = JSON.stringify(value);

    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        ...HARDENED
    });
    response.end(payload);
};

const failure = (response, status, code, message, remedy) =>
    json(response, remedy
        ? { ok: false, code, message, remedy }
        : { ok: false, code, message }, status);

const bytes = (response, buffer, contentType) => {
    response.writeHead(200, {
        'content-type': contentType,
        'content-length': buffer.length,
        ...HARDENED
    });
    response.end(buffer);
};

// The cap matters: this accepts uploaded packages, and without one a request could exhaust the TV.
const readBody = (request, limit = MAX_BODY) => new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;

    const stop = (message) => {
        request.destroy();
        reject(new Error(message));
    };

    // With its length stated, an upload is written into one buffer as it arrives instead of copied once
    // more at the end.
    const stated = Number(request.headers && request.headers['content-length']);
    if (stated > limit) return stop(`Body exceeded ${limit} bytes`);

    let whole = stated > 0 ? Buffer.allocUnsafe(stated) : null;

    request.on('data', (chunk) => {
        if (received + chunk.length > limit) return stop(`Body exceeded ${limit} bytes`);

        if (whole && received + chunk.length <= whole.length) {
            chunk.copy(whole, received);
        } else {
            if (whole) {
                chunks.push(whole.slice(0, received));
                whole = null;
            }
            chunks.push(chunk);
        }

        received += chunk.length;
        return undefined;
    });

    let ended = false;

    // A body that stops arriving — a phone gone to sleep, or a client holding the connection open on purpose
    // — is given up after half a minute of silence, rather than holding the one upload slot.
    if (typeof request.setTimeout === 'function') {
        request.setTimeout(IDLE_BODY, () => {
            if (ended) return;
            stop('The upload went quiet before the whole file arrived.');
        });
    }

    request.on('end', () => {
        ended = true;
        const body = whole ? whole.slice(0, received) : Buffer.concat(chunks);
        whole = null;
        resolve(body);
    });
    request.on('error', (error) => reject(error));

    // Node 12 says neither `end` nor `error` when the phone drops mid-upload — only `aborted` and `close` —
    // which left this waiting for ever, and every upload after it refused as busy.
    const dropped = () => {
        if (ended) return;
        whole = null;
        chunks.length = 0;
        reject(new Error('The upload stopped before the whole file arrived.'));
    };
    request.on('aborted', dropped);
    request.on('close', dropped);
});

module.exports = { json, failure, bytes, readBody, MAX_BODY };
