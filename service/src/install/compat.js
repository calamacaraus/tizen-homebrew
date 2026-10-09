'use strict';

// Which Tizen an app is for, and whether this television can run it.
//
// Two places say it. Before downloading, only names do — a collection's files and a catalog's entries are
// often named for the Tizen they were built for (`Overscan-tizen6.wgt`, `tube-1.1.0-tizen-5.5.wgt`,
// "YouTube - Tizen 5.0 ONLY"); that is a hint, shown on the phone. After downloading, the package itself
// says the least version it needs (config.xml's `required_version`, a native package's `api-version`),
// which is checked before anything is signed or installed.
//
// Newer televisions run apps built for older ones, so only "needs newer than this TV" is refused; an app
// built for an older Tizen is offered with a note when the same list has a build closer to this TV's.

const TIZEN_IN_NAME = /tizen[-_ ]?([2-9](?:\.\d)?)(?!\d|\.\d)/i;

// "4" and "4.0" are the same Tizen.
const normal = (text) => {
    const found = /^(\d+)(?:\.(\d+))?/.exec(String(text || '').trim());
    return found ? `${Number(found[1])}.${Number(found[2] || 0)}` : null;
};

const compare = (left, right) => {
    const a = normal(left);
    const b = normal(right);
    if (!a || !b) return null;

    const [am, an] = a.split('.').map(Number);
    const [bm, bn] = b.split('.').map(Number);

    return am !== bm ? Math.sign(am - bm) : Math.sign(an - bn);
};

// The Tizen a file or a list entry's name says it is for, or null when it does not say.
const fromName = (...texts) => {
    for (const text of texts) {
        const found = TIZEN_IN_NAME.exec(String(text || ''));
        if (found) return normal(found[1]);
    }
    return null;
};

// The name with its Tizen part taken out, to put the builds of one app together: "Overscan Tizen6" and
// "Overscan Tizen9" are both "overscan".
const baseOf = (name) => String(name || '')
    .replace(/[-_ ]*(?:-\s*)?tizen[-_ ]?[2-9](?:\.\d)?(?!\d|\.\d)(?:\s*only)?/ig, '')
    .replace(/[^a-z0-9]+/ig, ' ')
    .trim()
    .toLowerCase();

module.exports = { fromName, normal, compare, baseOf };
