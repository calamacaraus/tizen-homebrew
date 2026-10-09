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

module.exports = { allowedHost, hostnameOf };
