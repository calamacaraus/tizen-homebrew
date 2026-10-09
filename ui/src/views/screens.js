// Prose in the UI face, anything the machine produced in monospace, and `data-focus` on everything reachable.

import { html } from '../core/view.js';
import { wordmark } from './television.js';

const masthead = (state) => html`
  <div class="bar">
    ${wordmark()}
    <span class="inline">
      <span class="micro mono">${state.connection}</span>
      <button class="btn btn-quiet" data-focus="theme" data-on-click="theme"
              aria-pressed="${state.themeOn}"
              title="The Homebrew Channel theme">${state.themeOn ? 'theme · on' : 'theme · off'}</button>
    </span>
  </div>`;

// The only thing on screen until it is done, dressed as the other half of the code shown on the TV.
const pairing = (state) => (state.restoring ? html`
  <div class="state state-warn">
    <span class="state-head">Pairing</span>
    <span class="small">Offering the code this phone paired with last.</span>
  </div>` : html`
  <div class="glass pad stack stack-wide">
    <div class="stack stack-tight">
      <span class="label">Pairing required</span>
      <p class="small">Enter the six digits shown on the TV. They change each time the
        channel restarts.</p>
    </div>

    <input class="field code-field mono" id="pin" type="tel" inputmode="numeric" maxlength="6"
           autocomplete="off" placeholder="······" data-focus="pin" data-on-input="pin"
           aria-label="Six-digit code shown on the TV">

    ${state.pinError
        ? html`<div class="state state-fault">
             <span class="state-head">Rejected</span>
             <span class="small">${state.pinError}</span>
           </div>`
        : ''}
  </div>`);

const status = (state) => {
    const { device } = state;

    const band = (tone, head, body) => html`
      <div class="state state-${tone}">
        <span class="state-head">${head}</span>
        <span class="small">${body}</span>
      </div>`;

    if (!device) return band('warn', 'Checking', 'Asking the TV about itself.');

    if (!device.onTv) return band('warn', 'Off device', 'Running as a development harness. Installs need real hardware.');

    // Working is the ordinary state, and the page closes up over a band saying so.
    if (device.ready) return html``;

    if (device.reason === 'debugModeOff') {
        return band('warn', 'Developer mode off',
            html`Turn it on in Apps › 12345 › Settings, then restart the TV.`);
    }

    // The current developer IP is deliberately not quoted: the device API has reported 127.0.0.1 while sdbd
    // accepted only another machine.
    return band('warn', 'No sdb route',
        html`Set <span class="mono ink">Host PC IP</span> to <span class="mono ink">127.0.0.1</span>
             in Apps › 12345 › Settings, then restart the TV — that value is only read at startup.`);
};

const weight = (bytes) => (bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`);

const monogram = (name) => String(name || '?').trim().charAt(0) || '?';

const tile = (app, hero = false) => html`
  <span class="tile${hero ? ' tile-hero' : ''}">
    <span class="tile-mark">${monogram(app.name || app.packageId)}</span>
    ${app.icon ? html`<img class="tile-art" src="${app.icon}" alt="">` : ''}
  </span>`;

// Spans throughout: a USB row is a `<button>`, whose content model is phrasing content only.
const identity = (app, below = '', hero = false) => html`
  <span class="ident">
    ${tile(app, hero)}
    <span class="stack stack-tight">
      <span class="inline">
        <span class="name truncate">${app.name || app.packageId || 'Unnamed'}</span>
        ${app.version ? html`<span class="mono micro">${app.version}</span>` : ''}
      </span>
      ${below}
    </span>
  </span>`;

const TABS = [
    ['catalog', 'apps'],
    ['repos', 'repos'],
    ['upload', 'upload'],
    ['github', 'github'],
    ['url', 'url'],
    ['usb', 'usb'],
    ['relay', 'shell']
];

const tabs = (state) => html`
  <div class="tabs" role="tablist">
    ${TABS.map(([id, label]) => html`
      <button class="tab" role="tab" aria-selected="${state.tab === id}"
              data-focus="tab:${id}" data-on-click="tab:${id}">${label}</button>`)}
  </div>`;

// A destructive action takes two taps: the first turns the button into a question, which lapses after a few
// seconds untouched. No dialog, which a TV-sized page and a phone both make clumsy.
const confirmButton = (state, action, label, asking, extra = 'btn-quiet') => {
    const asked = state.confirming === action;

    return html`<button class="btn ${asked ? 'btn-warn' : extra}" data-focus="${action}"
        data-on-click="${asked ? action : `confirm:${action}`}" aria-live="polite">${asked ? asking : label}</button>`;
};

const section = (label, body, footer = '') => html`
  <div class="glass pad stack stack-snug">
    <span class="label">${label}</span>
    ${body}
    ${footer}
  </div>`;

const catalogued = (app) => {
    if (!app.installed) return html`<span class="small truncate">${app.description || app.source.ref}</span>`;

    const held = html`<span class="mono">${app.installed}</span>`;

    if (app.update) {
        return html`<span class="small">${held} → <span class="mono ink">${app.available || 'new build'}</span></span>`;
    }

    if (app.rebuilt) return html`<span class="small truncate">${held} installed · a new build of it is out</span>`;

    return html`<span class="small truncate">${held} installed${app.checked
        ? (app.available || app.sha256 ? ' · up to date' : ' · no release found')
        : ''}</span>`;
};

// Where the copy on the TV came from, in a few words: the list and repository, the GitHub tab, a URL,
// an upload or a USB stick — or that it was there before Homebrew kept a record.
const repositoryName = (id, state) => {
    if (!id || id === 'official') return 'Tizen Homebrew list';
    const found = (state.repositories || []).find((repository) => repository.id === id);
    return found ? found.name : 'a repository since removed';
};

const originText = (app, state) => {
    const origin = app.origin;

    if (!origin) return 'origin unknown · installed before this Homebrew kept records';
    if (origin.replaced) return 'changed outside Homebrew since it was installed from here';

    const what = {
        catalog: () => repositoryName(origin.repository, state) +
            ((origin.repository || 'official') === 'official' && origin.repo ? ` · ${origin.repo}` : ''),
        github: () => `GitHub ${origin.repo || ''}`.trim(),
        url: () => `link on ${origin.host || 'the web'}`,
        upload: () => 'phone upload',
        file: () => 'USB stick'
    }[origin.source];

    const file = origin.asset || origin.file;
    const day = origin.at ? String(origin.at).slice(0, 10) : null;

    return [what ? what() : origin.source, file, origin.tag, day, origin.verified ? 'sha256 ✓' : null]
        .filter(Boolean).join(' · ');
};

// While one install runs every install button waits: a second tap would only be refused as busy.
const action = (app, busy = false) => {
    if (app.unlisted) return '';

    const off = busy ? 'disabled' : '';

    if (!app.installed) {
        return html`<button class="btn btn-ghost" data-focus="app:${app.id}"
                       data-on-click="install:catalog:${app.id}" ${off}>install</button>`;
    }

    if (app.rebuilt) {
        return html`<button class="btn btn-ghost" data-focus="app:${app.id}"
                       data-on-click="install:catalog:${app.id}" ${off}>reinstall</button>`;
    }

    // Up to date: nothing to press, and the room goes to the name.
    if (!app.update) return '';

    return html`<button class="btn btn-signal"
                   data-focus="app:${app.id}" data-on-click="install:catalog:${app.id}" ${off}>update</button>`;
};

// A collection's app is checked by asking its repository again; one listed by URL has nothing to ask.
// Not when an update is already known: the button would only say so again, and the room goes to the name.
const recheck = (app, checking) => (app.unlisted || app.update || app.source.type !== 'github' || (app.collection && !app.installed) ? '' : html`
  <button class="btn btn-quiet" data-focus="check:${app.id}" data-on-click="check:${app.id}"
          ${checking ? 'disabled' : ''}>${checking === app.id ? 'checking…' : 'check'}</button>`);

// Your own name and icon, where you set them, are what the row shows: they are what the TV shows.
const dressed = (app, customizations) => {
    const custom = app.packageId && customizations ? customizations[app.packageId] : null;
    if (!custom) return app;

    return { ...app, name: custom.name || app.name, icon: custom.icon || app.icon };
};

// Not for an app no list names: a change to it could not be installed again without the file.
const edit = (app) => (app.installed && app.packageId && !app.unlisted ? html`
  <button class="btn btn-quiet btn-icon" data-focus="customize:${app.packageId}"
          data-on-click="customize:${app.packageId}" title="Your own name and icon"
          aria-label="Edit name and icon">✎</button>` : '');

const row = (app, checking, customizations, state = null) => {
    const shown = dressed(app, customizations);
    const searchable = [shown.name, app.name, app.description, app.source && app.source.ref, app.source && app.source.asset]
        .filter(Boolean).join(' ').toLowerCase();

    // The origin gets the row's whole width, under the name and buttons, rather than a column one word wide.
    return html`
      <div class="row" data-search="${searchable}">
        <div class="split">
          ${identity(shown, catalogued(app))}
          <span class="controls">
            ${edit(app)}
            ${recheck(app, checking)}
            ${action(app, Boolean(state && state.phase))}
          </span>
        </div>
        ${state && app.installed ? html`<span class="micro mono wrap origin">${originText(app, state)}</span>` : ''}
      </div>`;
};

const customizer = (state) => {
    const packageId = state.customizing;
    if (!packageId) return html``;

    const app = state.catalog.find((entry) => entry.packageId === packageId) || { packageId, name: packageId };
    const custom = state.customizations[packageId] || {};
    const icon = state.customIcon || custom.icon || app.icon;

    return section(`Customise ${app.name}`, html`
        <p class="small">Your own name and icon for this app on the TV’s home row. Kept for every update of it,
          from wherever it is installed.</p>

        <div class="row">
          ${identity({ ...app, name: state.customDraft.name || custom.name || app.name, icon }, html`
            <span class="mono micro truncate">${state.customIcon ? 'new icon chosen' : custom.icon ? 'your icon' : 'the app’s own icon'}</span>`, true)}
        </div>

        <input class="field" id="cname" aria-label="Name on the TV" placeholder="${app.name}" value="${state.customDraft.name}"
               data-focus="cname" data-on-input="cname" maxlength="60" autocapitalize="words" spellcheck="false">

        <input id="cicon" class="visually-hidden" type="file" accept="image/png,image/jpeg" data-on-change="customIcon">

        <label for="cicon" class="drop">
          <span class="mono small">choose an icon</span>
          <span class="micro mono">PNG or JPEG · fitted to 512×512</span>
        </label>`,
    html`<span class="controls">
        <button class="btn btn-signal" data-focus="custom:apply" data-on-click="custom:apply"
                ${state.customBusy ? 'disabled' : ''}>save &amp; reinstall</button>
        <button class="btn btn-ghost" data-focus="custom:save" data-on-click="custom:save"
                ${state.customBusy ? 'disabled' : ''}>save</button>
        ${state.customizations[packageId] ? confirmButton(state, 'custom:reset', 'reset', 'tap again to reset') : ''}
        <button class="btn btn-quiet" data-focus="custom:close" data-on-click="custom:close">close</button>
      </span>`);
};

// Grouped by where each app is listed, in the order the repositories were added.
const grouped = (state) => {
    const known = state.repositories.length
        ? state.repositories
        : [{ id: 'official', name: 'Tizen Homebrew' }];

    const groups = known
        .map((repository) => ({ repository, apps: state.catalog.filter((app) => (app.repository || 'official') === repository.id) }))
        .filter((group) => group.apps.length);

    // Anything from a repository that is no longer listed still shows, rather than vanishing.
    const placed = groups.reduce((count, group) => count + group.apps.length, 0);
    if (placed < state.catalog.length) {
        const ids = known.map((repository) => repository.id);
        groups.push({ repository: { id: 'other', name: 'Other' }, apps: state.catalog.filter((app) => ids.indexOf(app.repository || 'official') === -1) });
    }

    return groups;
};

const run = (state) => {
    const progress = state.updateRun;
    if (!progress) return html``;

    if (progress.running) {
        const done = progress.total ? Math.round((progress.index / progress.total) * 100) : 0;

        return html`
          <div class="state state-warn">
            <span class="state-head">Updating${progress.total ? ` ${progress.index + 1} of ${progress.total}` : ''}</span>
            <span class="small truncate">${progress.current || 'Looking for updates…'}</span>
            <div class="meter"><i style="width:${done}%"></i></div>
          </div>`;
    }

    if (progress.error) {
        return html`<div class="state state-fault"><span class="state-head">Could not update</span>
          <span class="small wrap">${progress.error}</span></div>`;
    }

    const failed = progress.failed || [];
    const updated = progress.updated || [];

    if (!updated.length && !failed.length) {
        return html`<div class="state state-ok"><span class="state-head">Up to date</span>
          <span class="small">${progress.available && progress.available.length
              ? `Newer: ${progress.available.join(', ')}`
              : 'Nothing has a newer release.'}</span></div>`;
    }

    return html`
      <div class="state ${failed.length ? 'state-fault' : 'state-ok'}">
        <span class="state-head">${updated.length ? `Updated ${updated.length}` : 'Nothing updated'}</span>
        ${updated.length ? html`<span class="small wrap">${updated.join(', ')}</span>` : ''}
        ${failed.map((failure) => html`<span class="small wrap"><span class="ink">${failure.name}</span> · ${failure.message}</span>`)}
      </div>`;
};

// One row per package on this TV: the same app can be listed by more than one repository, and the
// built-in list answers for it first. What is not installed is offered below, by where it is listed.
const installedRows = (state) => {
    const seen = {};
    const rank = (app) => ((app.repository || 'official') === 'official' ? 0 : app.collection ? 2 : 1);

    state.catalog.filter((app) => app.installed)
        .slice()
        .sort((a, b) => rank(a) - rank(b))
        .forEach((app) => {
            const key = app.packageId || app.id;
            if (!seen[key]) seen[key] = app;
        });

    // Installed from an upload, a URL, the GitHub tab or a stick: no list names them, but they are on the TV.
    (state.others || []).forEach((app) => {
        if (!seen[app.packageId]) seen[app.packageId] = app;
    });

    return Object.keys(seen).map((key) => seen[key])
        .sort((a, b) => (Number(Boolean(b.update)) - Number(Boolean(a.update))) || String(a.name).localeCompare(String(b.name)));
};

const catalog = (state) => {
    const pending = state.catalog.filter((app) => app.update).length;
    const rebuilt = state.catalog.filter((app) => app.rebuilt).length;
    const busy = Boolean(state.updateRun && state.updateRun.running);

    const toolbar = html`<span class="toolbar">
      <button class="btn btn-ghost" data-focus="refresh" data-on-click="catalog:refresh">refresh</button>
      <button class="btn btn-ghost" data-focus="check-all" data-on-click="checkAll"
              ${state.checking || busy ? 'disabled' : ''}>${state.checking === 'all'
        ? 'checking…' : 'check all'}</button>
      ${pending ? html`<button class="btn btn-signal" data-focus="update-all" data-on-click="updateAll"
              ${busy ? 'disabled' : ''}>update all · ${pending}</button>` : ''}
      ${rebuilt && !pending ? html`<button class="btn btn-ghost" data-focus="update-rebuilt" data-on-click="updateAll:rebuilt"
              ${busy ? 'disabled' : ''}>reinstall rebuilt · ${rebuilt}</button>` : ''}
    </span>`;

    if (state.catalog.length === 0) {
        return html`${customizer(state)}${run(state)}${section('Apps', html`
          ${toolbar}
          <p class="small">Nothing listed yet. Add a repository under repos, or use upload, github or url.</p>`)}`;
    }

    const installed = installedRows(state);
    const held = {};
    installed.forEach((app) => { if (app.packageId) held[app.packageId] = true; });

    // Not installed, and not another listing of a package that is.
    const offered = { ...state, catalog: state.catalog.filter((app) => !app.installed && !(app.packageId && held[app.packageId])) };
    const groups = grouped(offered);

    const onTv = installed.length
        ? html`<div class="list">${installed.map((app) => row(app, state.checking, state.customizations, state))}</div>`
        : html`<p class="small">Nothing from these lists is installed yet.</p>`;

    const available = groups.length
        ? html`${groups.map((group) => html`
            <div class="stack stack-tight">
              <span class="micro mono">${group.repository.name} · ${group.apps.length}</span>
              <div class="list">${group.apps.map((app) => row(app, state.checking, state.customizations, state))}</div>
            </div>`)}`
        : html`<p class="small">Everything listed is installed.</p>`;

    // Filtered as you type by the page itself (main.js), so typing never redraws the list or loses the field.
    const filter = html`<input class="field filter" id="filter" type="search" aria-label="Filter apps by name"
        placeholder="filter ${state.catalog.length + (state.others || []).length} apps" data-focus="filter" data-on-input="filter"
        autocapitalize="off" autocorrect="off" spellcheck="false">`;

    return html`${customizer(state)}${run(state)}
      ${filter}
      ${section(`On this TV · ${installed.length}`, html`${toolbar}${onTv}`)}
      ${section('Available to install', available)}`;
};

const MODES = [
    ['off', 'off', 'Only when you press update.'],
    ['check', 'check daily', 'Looks once a day and lists what is newer, here and on the TV.'],
    ['install', 'install daily', 'Looks once a day and installs what is newer, with nobody at the phone.']
];

const when = (iso) => {
    if (!iso) return 'never';
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
    return `${Math.round(minutes / 1440)} days ago`;
};

const repoRow = (state) => (repository) => html`
  <div class="row split">
    <span class="stack stack-tight">
      <span class="inline">
        <span class="name truncate">${repository.name}</span>
        <span class="mono micro">${repository.builtIn ? 'built in' : repository.kind === 'github' ? 'collection' : 'catalog'}</span>
      </span>
      <span class="small truncate">${repository.count === null || repository.count === undefined
          ? 'not loaded yet'
          : `${repository.count} ${repository.count === 1 ? 'app' : 'apps'}`}${repository.error
          ? html` · <span class="ink">${repository.stale && repository.count ? 'offline, showing the last list' : repository.error}</span>`
          : ''}</span>
    </span>
    <span class="controls">
      ${repository.builtIn ? '' : confirmButton(state, `unrepo:${repository.id}`, 'remove', 'tap again to remove')}
    </span>
  </div>`;

const repos = (state) => {
    const mode = state.settings ? state.settings.autoUpdate : null;
    const last = state.settings && state.settings.lastResult;

    return html`
      ${section('Repositories', html`
        <p class="small">Add a GitHub <span class="mono ink">owner/repo</span> whose newest release holds the apps — a
          collection like <span class="mono ink">example/tv-packages</span> — or an https link to a
          catalog.json. Its apps appear under apps.</p>
        <div class="list">${state.repositories.map(repoRow(state))}</div>
        <div class="entry">
          <input class="field" id="repo" aria-label="Repository to add" placeholder="owner/repo or https://…/catalog.json"
                 data-focus="repo" data-on-enter="repo:add"
                 autocapitalize="off" autocorrect="off" spellcheck="false">
          <button class="btn" data-focus="repo:go" data-on-click="repo:add"
                  ${state.repoBusy ? 'disabled' : ''}>${state.repoBusy ? 'adding…' : 'add'}</button>
        </div>`)}
      ${section('Automatic updates', html`
        <fieldset class="list plain">
          <legend class="visually-hidden">Automatic updates</legend>
          ${MODES.map(([value, label, hint]) => html`
            <label class="toggle">
              <input type="radio" name="auto" data-focus="auto:${value}" data-on-change="auto:${value}"
                     ${mode === value ? 'checked' : ''}>
              <span class="stack stack-tight"><span class="small ink">${label}</span><span class="micro">${hint}</span></span>
            </label>`)}
        </fieldset>
        <span class="micro mono">last looked ${when(state.settings && state.settings.lastCheck)}${last && last.updated && last.updated.length
            ? ` · updated ${last.updated.join(', ')}` : ''}${last && last.available && last.available.length
            ? ` · newer: ${last.available.join(', ')}` : ''}</span>`)}`;
};

// The archive is on the phone already, so it is opened and the well shows the app rather than the filename.
const chosen = (state) => {
    if (!state.file) {
        return html`
          <span class="mono small">choose a file</span>
          <span class="micro mono">or drag one here</span>`;
    }

    const app = state.identity || { name: state.file.name };

    const facts = [
        state.identity && state.identity.packageId,
        state.identity && state.file.name,
        weight(state.file.size)
    ].filter(Boolean).join(' · ');

    return identity(app, html`
      <span class="mono micro truncate">${state.reading ? 'reading the package…' : facts}</span>`, true);
};

const upload = (state) => section('Upload a package', html`
    <p class="small">Send a .wgt straight from this device. Nothing needs hosting.</p>

    <input id="file" class="visually-hidden" type="file" accept=".wgt,.tpk" data-on-change="file">
    <label for="file" class="drop${state.file ? ' drop-filled' : ''}">${chosen(state)}</label>

    ${state.uploading !== null ? html`<div class="meter"><i style="width:${state.uploading}%"></i></div>` : ''}`,
    state.file
        ? html`<button class="btn btn-signal btn-wide" data-focus="upload" data-on-click="upload"
                       ${state.uploading !== null ? 'disabled' : ''}>install</button>`
        : '');

const remoteSource = ({ label, id, placeholder, action, hint, value, busy = false }) => section(label, html`
    <div class="entry">
      <input class="field" id="${id}" aria-label="${label}" placeholder="${placeholder}" value="${value || ''}"
             data-focus="${id}" data-on-enter="${action}"
             autocapitalize="off" autocorrect="off" spellcheck="false">
      <button class="btn" data-focus="${id}:go" data-on-click="${action}" ${busy ? 'disabled' : ''}>install</button>
    </div>
    <p class="small">${hint}</p>`);

const weightOf = (bytes) => (bytes ? weight(bytes) : '');

const releaseFiles = (state) => {
    if (state.releaseLoading) return html`<p class="small">Asking GitHub for the newest release…</p>`;

    const release = state.release;
    if (!release) return html``;

    if (!release.assets.length) {
        return html`<div class="state state-warn"><span class="state-head">No packages</span>
          <span class="small">${release.repo} ${release.tag || ''} has no .wgt or .tpk files.</span></div>`;
    }

    return html`
      <span class="micro mono">${release.repo} · ${release.tag || 'untagged'}${release.assets.length > 1
          ? ` · ${release.assets.length} files` : ''}</span>
      <div class="list">
        ${release.assets.map((file) => html`
          <div class="row split">
            <span class="stack stack-tight">
              <span class="name truncate">${file.name}</span>
              <span class="mono micro truncate">${[weightOf(file.size), file.sha256 ? `sha256 ${file.sha256.slice(0, 12)}…` : 'no checksum published']
                  .filter(Boolean).join(' · ')}</span>
            </span>
            <span class="controls">
              <button class="btn btn-ghost" data-focus="asset:${file.name}" data-on-click="asset:${file.name}">install</button>
            </span>
          </div>`)}
      </div>
      ${release.assets.length > 1 ? html`
        <button class="btn btn-ghost btn-wide" data-focus="collection:add" data-on-click="collection:add">
          add ${release.repo} as a collection</button>` : ''}`;
};

const fromGitHub = (state) => section('GitHub release', html`
    <div class="entry">
      <input class="field" id="gh" placeholder="owner/repo" value="${state.github || ''}"
             data-focus="gh" data-on-enter="install:github"
             autocapitalize="off" autocorrect="off" spellcheck="false">
      <button class="btn" data-focus="gh:go" data-on-click="install:github"
              ${state.releaseLoading ? 'disabled' : ''}>find</button>
    </div>
    <p class="small">Lists the files in the newest release, with their published sha256, to install one.
      Public repositories only.</p>
    ${releaseFiles(state)}`);

const fromUrl = (state) => remoteSource({
    label: 'Direct URL', id: 'url', placeholder: 'https://…/App.wgt', action: 'install:url',
    hint: 'Must be https.', value: state.url, busy: Boolean(state.phase)
});

const usb = (state) => section('Attached storage', html`
    <span class="mono small truncate">${state.usbPath}</span>
    <div class="list">
      ${state.usb.map((entry) => (entry.isDirectory
        ? html`
          <button class="row row-button inline" data-focus="path:${entry.path}"
                  data-on-click="usb:${entry.path}">
            <span class="mono micro">/</span>
            <span class="mono truncate small">${entry.name}</span>
          </button>`
        : html`
          <button class="row row-button" data-focus="path:${entry.path}"
                  data-on-click="usb:${entry.path}">
            ${identity(entry.identity || { name: entry.name }, html`
              <span class="mono micro truncate">${[
                  entry.identity && entry.identity.packageId,
                  entry.identity && entry.name,
                  entry.size ? weight(entry.size) : null
              ].filter(Boolean).join(' · ')}</span>`)}
          </button>`))}
    </div>`);

const relay = (state) => section('Command relay', html`
    <p class="small">Developer Mode is pinned to loopback, so no other machine can reach this
      TV’s sdb daemon. The channel runs on the TV, so it can — and can relay for you.</p>

    <div class="state state-warn">
      <span class="state-head">Arbitrary commands</span>
      <span class="small">Leave this off unless you are using it.</span>
    </div>

    <label class="toggle">
      <input type="checkbox" data-focus="relay" ${state.relayEnabled ? 'checked' : ''}
             data-on-change="relay:toggle">
      <span class="small">Enable the relay</span>
    </label>

    ${state.relayEnabled ? html`
      <div class="entry">
        <input class="field" id="cmd" aria-label="Command to run on the TV" placeholder="pkgcmd -l" data-focus="cmd"
               data-on-enter="relay:run" autocapitalize="off" autocorrect="off" spellcheck="false">
        <button class="btn" data-focus="cmd:go" data-on-click="relay:run"
                ${state.relayBusy ? 'disabled' : ''}>run</button>
      </div>
      <pre class="log shell">${state.relayOutput || ' '}</pre>` : ''}`);

const PANELS = { catalog, repos, upload, github: fromGitHub, url: fromUrl, usb, relay };

const panel = (state) => PANELS[state.tab](state);

const PHASES = ['probing', 'fetching', 'resigning', 'staging', 'installing'];

const PHASE_WORDS = {
    probing: 'Checking the TV',
    fetching: 'Downloading',
    resigning: 'Re-signing',
    staging: 'Copying to the TV',
    installing: 'Installing'
};

const outcome = (state) => {
    if (state.phase) {
        const step = PHASES.indexOf(state.phase) + 1;
        const app = state.identity;

        const named = app && (app.name || app.packageId);
        const detail = state.phaseDetail && state.phaseDetail !== named
            ? ` · ${state.phaseDetail}`
            : '';

        return html`
          <div class="glass pad stack stack-snug">
            ${app ? identity(app, html`<span class="mono micro truncate">${app.packageId}</span>`) : ''}
            <div class="split split-baseline">
              <span class="value truncate">${PHASE_WORDS[state.phase] || state.phase}</span>
              <span class="mono micro">${step}/${PHASES.length}${detail}</span>
            </div>
            <div class="meter"><i style="width:${Math.round((step / PHASES.length) * 100)}%"></i></div>
          </div>`;
    }

    if (state.error) {
        // What went wrong, what the television said, and what to do about it — the last absent when nothing
        // has a cure.
        return html`
          <div class="state state-fault" role="alert">
            <span class="state-head">Failed</span>
            <span class="small ink">${state.error.title}</span>
            <span class="mono micro wrap">${state.error.detail}</span>
            ${state.error.remedy ? html`<span class="small wrap">${state.error.remedy}</span>` : html``}
            ${state.error.confirmable ? html`<span class="controls">
              ${confirmButton(state, 'install:anyway', 'replace it anyway', 'tap again to replace it', 'btn-warn')}
            </span>` : html``}
          </div>`;
    }

    if (state.done) {
        const app = state.identity || state.done;

        return html`
          <div class="state state-ok">
            <span class="state-head">Installed</span>
            ${identity(app, html`<span class="mono micro truncate">${app.packageId || ''}</span>`)}
            <span class="small">On the TV’s home row.${state.done && state.done.verified
                ? ' The download matched its published sha256.' : ''}</span>
          </div>`;
    }

    return html``;
};

export { masthead, pairing, status, tabs, panel, outcome };
