'use strict';

// DNS rebinding: a web site can point its own name at this television's address, and the browser then
// treats the TV as that site — same origin, so it reads the answers. Every request names the host it
// thinks it is talking to, and that name is what gives it away: a phone reaches this by IP address, and
// the television's own page by 127.0.0.1. Names a router hands out are fine too — a bare name, or one under
// a suffix nobody can register on the public internet (.local, .lan, .home.arpa, …) — because a rebinding
// site has to use a name it registered. Anything else is refused before it is answered, the loopback
// greeting with the PIN included. HOMEBREW_HOSTNAMES (comma-separated) adds names for a development box.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const PRIVATE_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain', '.intranet', '.corp',
    '.fritz.box'];

const extra = String(process.env.HOMEBREW_HOSTNAMES || '')
    .split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);

const hostnameOf = (header) => {
    const value = String(header || '').trim().toLowerCase();

    if (value.charAt(0) === '[') return value.slice(0, value.indexOf(']') + 1);

    return value.replace(/:\d+$/, '');
};

const allowedHost = (header) => {
    // HTTP/1.0 and some tools send none; there is no name to have been rebound.
    if (!header) return true;

    const name = hostnameOf(header);

    return IPV4.test(name) ||
        name.charAt(0) === '[' ||
        name === 'localhost' ||
        (name.length > 0 && name.indexOf('.') === -1) ||
        PRIVATE_SUFFIXES.some((suffix) => name.length > suffix.length && name.slice(-suffix.length) === suffix) ||
        extra.indexOf(name) !== -1;
};

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

const isLoopback = (address) => LOOPBACK.indexOf(String(address || '')) !== -1;

// Origins a developer serves the phone page from, by hand, for a build being worked on. Nothing else
// on localhost is believed: any other app's local web server on the TV would be.
const DEV_ORIGINS = String(process.env.HOMEBREW_DEV_ORIGINS || '')
    .split(',').map((origin) => origin.trim().toLowerCase()).filter(Boolean);

// Who may be trusted without the PIN: a caller sending no Origin (the service's own tools — a browser
// page that sends none cannot read the answer), a packaged app's page (a real non-http scheme, file://
// on the television), or this service's own page. Not "null" — a sandboxed frame or a data: page in the
// TV's browser sends that, and would otherwise be handed the PIN — and not any other web page: the TV's
// browser reaches 127.0.0.1 too.
const trustedOrigin = (origin, hostHeader) => {
    if (!origin) return true;

    const typed = String(origin).trim().toLowerCase();
    if (typed === 'null') return false;
    if (DEV_ORIGINS.indexOf(typed) !== -1) return true;

    let parsed = null;

    try {
        parsed = new URL(origin);
    } catch (e) {
        return false;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return parsed.protocol !== 'data:' && parsed.protocol !== 'blob:';

    return parsed.host.toLowerCase() === String(hostHeader || '').toLowerCase();
};

// The loopback trust every PIN-less route and the socket greeting rely on.
const trustedLocal = (request) => Boolean(request && request.socket && isLoopback(request.socket.remoteAddress) &&
    trustedOrigin(request.headers && request.headers.origin, request.headers && request.headers.host));

module.exports = { allowedHost, hostnameOf, isLoopback, trustedOrigin, trustedLocal };
