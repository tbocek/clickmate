# Clickmate Autoclicker

...

## Installation

 * create binary with ```make```
 * install it with ```sudo make install```

This will copy 3 files: clickmate, 80-clickmate.rules, and clickmate@.service

T
## Run




## Unistallation

To uninstall with make use:

```
sudo make uninstall
```

To uninstall manually, you can type (if you are not root, use sudo):

```
systemctl stop 'clickmate@*.service'
rm /usr/local/bin/clickmate
rm /etc/udev/rules.d/80-clickmate.rules
rm /etc/systemd/system/clickmate@.service
udevadm control --reload
systemctl restart systemd-udevd.service
systemctl daemon-reload
```

### Resolving a Boot Delay

If you experience an x-minute boot delay after installing the script, it's likely due to the `systemd-udev-settle.service`. The code seems to call this service, causing the computer to wait for device initialization, which significantly slows down the boot process.

This service is deprecated, and you can restore normal boot times by masking it with the following command:
```bash
systemctl mask systemd-udev-settle.service
```

---

## Related Links
I used the following sites for inspiration:

 * https://www.kernel.org/doc/html/v4.12/input/uinput.html
 * https://www.linuxquestions.org/questions/programming-9/uinput-any-complete-example-4175524044/
 * https://stackoverflow.com/questions/20943322/accessing-keys-from-linux-input-device
 * https://gist.github.com/toinsson/7e9fdd3c908b3c3d3cd635321d19d44d
