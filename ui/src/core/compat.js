// The phone's half of service/src/install/compat.js: comparing an app's Tizen with this TV's, and putting
// the builds of one app together. Kept the same on purpose; the service checks the package itself again.

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

const baseOf = (name) => String(name || '')
    .replace(/[-_ ]*(?:-\s*)?tizen[-_ ]?[2-9](?:\.\d)?(?!\d|\.\d)(?:\s*only)?/ig, '')
    .replace(/[^a-z0-9]+/ig, ' ')
    .trim()
    .toLowerCase();

// Each app marked for this TV: `blocked` when it is for a newer Tizen; among several builds of one app in a
// list, `best` for the newest this TV runs and `older` for the ones below it.
const annotate = (apps, tv) => {
    const groups = {};
    apps.forEach((app) => {
        if (!app.forTizen) return;
        const key = `${app.repository || 'official'}|${baseOf(app.name)}`;
        (groups[key] = groups[key] || []).push(app);
    });

    const best = {};
    Object.keys(groups).forEach((key) => {
        if (groups[key].length < 2 || !tv) return;
        const runnable = groups[key].filter((app) => compare(app.forTizen, tv) !== 1);
        runnable.sort((a, b) => compare(b.forTizen, a.forTizen));
        if (runnable.length) best[key] = runnable[0].id;
    });

    return apps.map((app) => {
        if (!app.forTizen) return app;

        const key = `${app.repository || 'official'}|${baseOf(app.name)}`;
        const blocked = Boolean(tv) && compare(app.forTizen, tv) === 1;
        const several = groups[key] && groups[key].length > 1;

        return {
            ...app,
            fit: {
                tizen: normal(app.forTizen),
                tv: tv ? normal(tv) : null,
                blocked,
                best: several && best[key] === app.id,
                older: several && !blocked && best[key] && best[key] !== app.id
            }
        };
    });
};

export { normal, compare, baseOf, annotate };
