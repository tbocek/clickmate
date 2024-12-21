const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const GObject = imports.gi.GObject;

let myPopup;

function init() {
    log('initializing');
}

function enable() {
    myPopup = new MyPopup();
    Main.panel.addToStatusArea('myPopup', myPopup);
}

function disable() {
    myPopup.destroy();
    myPopup = null;
}

const MyPopup = GObject.registerClass(
    class MyPopup extends PanelMenu.Button {
        _init() {
            super._init(0.0);

            let icon = new St.Icon({
                icon_name: 'face-smile-symbolic',
                style_class: 'system-status-icon'
            });

            this.add_child(icon);

            let menuItem = new PopupMenu.PopupMenuItem('Hello World!');
            this.menu.addMenuItem(menuItem);
        }
    }
);