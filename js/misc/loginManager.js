// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported canLock, getLoginManager, registerSessionWithGDM */

const { GLib, Gio } = imports.gi;
const Signals = imports.signals;

const { loadInterfaceXML } = imports.misc.fileUtils;

const SystemdLoginManagerIface = loadInterfaceXML('org.freedesktop.login1.Manager');
const SystemdLoginSessionIface = loadInterfaceXML('org.freedesktop.login1.Session');
const SystemdLoginUserIface = loadInterfaceXML('org.freedesktop.login1.User');

const SystemdLoginManager = Gio.DBusProxy.makeProxyWrapper(SystemdLoginManagerIface);
const SystemdLoginSession = Gio.DBusProxy.makeProxyWrapper(SystemdLoginSessionIface);
const SystemdLoginUser = Gio.DBusProxy.makeProxyWrapper(SystemdLoginUserIface);

function haveSystemd() {
    return GLib.access("/run/systemd/seats", 0) >= 0;
}

function versionCompare(required, reference) {
    required = required.split('.');
    reference = reference.split('.');

    for (let i = 0; i < required.length; i++) {
        let requiredInt = parseInt(required[i]);
        let referenceInt = parseInt(reference[i]);
        if (requiredInt != referenceInt)
            return requiredInt < referenceInt;
    }

    return true;
}

function canLock() {
    try {
        let params = GLib.Variant.new('(ss)', ['org.gnome.DisplayManager.Manager', 'Version']);
        let result = Gio.DBus.system.call_sync('org.gnome.DisplayManager',
                                               '/org/gnome/DisplayManager/Manager',
                                               'org.freedesktop.DBus.Properties',
                                               'Get', params, null,
                                               Gio.DBusCallFlags.NONE,
                                               -1, null);

        let version = result.deep_unpack()[0].deep_unpack();
        return haveSystemd() && versionCompare('3.5.91', version);
    } catch (e) {
        return false;
    }
}


async function registerSessionWithGDM() {
    log("Registering session with GDM");
    try {
        await Gio.DBus.system.call(
            'org.gnome.DisplayManager',
            '/org/gnome/DisplayManager/Manager',
            'org.gnome.DisplayManager.Manager',
            'RegisterSession',
            GLib.Variant.new('(a{sv})', [{}]), null,
            Gio.DBusCallFlags.NONE, -1, null);
    } catch (e) {
        if (!e.matches(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD))
            log(`Error registering session with GDM: ${e.message}`);
        else
            log('Not calling RegisterSession(): method not exported, GDM too old?');
    }
}

let _loginManager = null;

/**
 * getLoginManager:
 * An abstraction over systemd/logind and ConsoleKit.
 * @returns {object} - the LoginManager singleton
 *
 */
function getLoginManager() {
    if (_loginManager == null) {
        if (haveSystemd())
            _loginManager = new LoginManagerSystemd();
        else
            _loginManager = new LoginManagerDummy();
    }

    return _loginManager;
}

var LoginManagerSystemd = class {
    constructor() {
        this._proxy = new SystemdLoginManager(Gio.DBus.system,
                                              'org.freedesktop.login1',
                                              '/org/freedesktop/login1');
        this._userProxy = new SystemdLoginUser(Gio.DBus.system,
                                               'org.freedesktop.login1',
                                               '/org/freedesktop/login1/user/self');
        this._proxy.connectSignal('PrepareForSleep',
                                  this._prepareForSleep.bind(this));
    }

    getCurrentSessionProxy(callback) {
        if (this._currentSession) {
            callback(this._currentSession);
            return;
        }

        let sessionId = GLib.getenv('XDG_SESSION_ID');
        if (!sessionId) {
            log('Unset XDG_SESSION_ID, getCurrentSessionProxy() called outside a user session. Asking logind directly.');
            let [session, objectPath] = this._userProxy.Display;
            if (session) {
                log(`Will monitor session ${session}`);
                sessionId = session;
            } else {
                log('Failed to find "Display" session; are we the greeter?');

                for ([session, objectPath] of this._userProxy.Sessions) {
                    let sessionProxy = new SystemdLoginSession(Gio.DBus.system,
                                                               'org.freedesktop.login1',
                                                               objectPath);
                    log(`Considering ${session}, class=${sessionProxy.Class}`);
                    if (sessionProxy.Class == 'greeter') {
                        log(`Yes, will monitor session ${session}`);
                        sessionId = session;
                        break;
                    }
                }

                if (!sessionId) {
                    log('No, failed to get session from logind.');
                    return;
                }
            }
        }

        this._proxy.GetSessionRemote(sessionId, (result, error) => {
            if (error) {
                logError(error, 'Could not get a proxy for the current session');
            } else {
                this._currentSession = new SystemdLoginSession(Gio.DBus.system,
                                                               'org.freedesktop.login1',
                                                               result[0]);
                callback(this._currentSession);
            }
        });
    }

    canSuspend(asyncCallback) {
        this._proxy.CanSuspendRemote((result, error) => {
            if (error) {
                asyncCallback(false, false);
            } else {
                let needsAuth = result[0] == 'challenge';
                let canSuspend = needsAuth || result[0] == 'yes';
                asyncCallback(canSuspend, needsAuth);
            }
        });
    }

    canRebootToBootLoaderMenu(asyncCallback) {
        this._proxy.CanRebootToBootLoaderMenuRemote((result, error) => {
            if (error) {
                asyncCallback(false, false);
            } else {
                const needsAuth = result[0] === 'challenge';
                const canRebootToBootLoaderMenu = needsAuth || result[0] === 'yes';
                asyncCallback(canRebootToBootLoaderMenu, needsAuth);
            }
        });
    }

    setRebootToBootLoaderMenu() {
        /* Parameter is timeout in usec, show to menu for 60 seconds */
        this._proxy.SetRebootToBootLoaderMenuRemote(60000000);
    }

    listSessions(asyncCallback) {
        this._proxy.ListSessionsRemote((result, error) => {
            if (error)
                asyncCallback([]);
            else
                asyncCallback(result[0]);
        });
    }

    suspend() {
        this._proxy.SuspendRemote(true);
    }

    async inhibit(reason, cancellable) {
        const inVariant = new GLib.Variant('(ssss)',
            ['sleep', 'GNOME Shell', reason, 'delay']);
        const [outVariant_, fdList] =
            await this._proxy.call_with_unix_fd_list('Inhibit',
                inVariant, 0, -1, null, cancellable);
        const [fd] = fdList.steal_fds();
        return new Gio.UnixInputStream({ fd });
    }

    _prepareForSleep(proxy, sender, [aboutToSuspend]) {
        this.emit('prepare-for-sleep', aboutToSuspend);
    }
};
Signals.addSignalMethods(LoginManagerSystemd.prototype);

var LoginManagerDummy = class {
    getCurrentSessionProxy(_callback) {
        // we could return a DummySession object that fakes whatever callers
        // expect (at the time of writing: connect() and connectSignal()
        // methods), but just never calling the callback should be safer
    }

    canSuspend(asyncCallback) {
        asyncCallback(false, false);
    }

    canRebootToBootLoaderMenu(asyncCallback) {
        asyncCallback(false, false);
    }

    setRebootToBootLoaderMenu() {
    }

    listSessions(asyncCallback) {
        asyncCallback([]);
    }

    suspend() {
        this.emit('prepare-for-sleep', true);
        this.emit('prepare-for-sleep', false);
    }

    /* eslint-disable-next-line require-await */
    async inhibit() {
        return null;
    }
};
Signals.addSignalMethods(LoginManagerDummy.prototype);
