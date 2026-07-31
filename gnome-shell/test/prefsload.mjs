// Load the built preferences module the way the Extensions app does — against
// the shell's own prefs.js resource, not a stub. Nothing here builds a window;
// the point is the import itself, because gettext refuses to run while the
// module is still being imported and a translated string at file scope takes
// the whole settings window down with a bare "gettext can only be called from
// extensions".
//
// Skips itself where gnome-shell is not installed, so the suite still runs.

import Gio from 'gi://Gio';

const RESOURCE = '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource';
// Relative to this file rather than to the working directory, so it does not
// matter where the suite is run from.
const PREFS = import.meta.url.replace(/\/test\/[^/]+$/, '/dist/prefs.js');

if (!Gio.File.new_for_path(RESOURCE).query_exists(null)) {
    print('skip prefs load: gnome-shell is not installed here');
} else {
    Gio.resources_register(Gio.resource_load(RESOURCE));
    try {
        await import(PREFS);
        print('ok   the preferences module imports against the real shell');
    } catch (error) {
        print(`FAIL preferences module does not import: ${error.message}`);
        print('     (a gettext call at file scope is the usual cause)');
        imports.system.exit(1);
    }
}
