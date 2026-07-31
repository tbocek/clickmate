// clickmate - generic evdev input service for macro recording and playback.
//
// Each device passed with -d is grabbed (EVIOCGRAB), cloned to a uinput device
// and forwarded event-for-event, exactly as the original autoclicker did. On top
// of that the daemon exposes a small JSON API over a unix socket so that the
// GNOME Shell extension can inject arbitrary event trains and observe real input
// while recording. No macro logic lives here: loops, conditions and timing all
// live in the extension so that aborting is instant.

#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <stdlib.h>
#include <errno.h>
#include <time.h>
#include <sys/time.h>
#include <pthread.h>
#include <stdbool.h>
#include <signal.h>
#include <microhttpd.h>
#include <json-c/json.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <dirent.h>
#include <strings.h>
#include <limits.h>
#include <sys/inotify.h>
#include <poll.h>

#define SOCKET_PATH       "/var/run/click-socket"
#define EVENT_SOCKET_PATH "/var/run/clickmate-events"

#define MAX_DEVICES        8
#define MAX_STREAM_CLIENTS 8
#define MAX_PLAY_EVENTS    100000
#define API_VERSION        2

#define CLASS_KEYBOARD 1
#define CLASS_POINTER  2

struct captured_device {
    char *path;
    int fdi;              // real device, grabbed (-1 for synthetic or detached)
    int fdo;              // uinput clone
    pthread_t reader;
    bool grabbed;
    bool alive;           // a reader thread is currently on fdi
    int cls;              // bitmask of CLASS_*
    int index;
    char name[64];
    char wanted[256];     // the -n name or -d path that owns this slot
};

static struct captured_device devices[MAX_DEVICES];
static int device_count = 0;

// Guards devices[] and device_count against the monitor thread attaching a
// device while playback is picking one. Slots are never freed or moved, so a
// pointer handed out by device_for() stays valid after the lock is dropped.
static pthread_mutex_t devices_mutex = PTHREAD_MUTEX_INITIALIZER;

// What was asked for on the command line, kept so the monitor thread can match
// a newly appeared device against it.
struct device_spec {
    bool by_name;
    const char *value;
};
static struct device_spec specs[MAX_DEVICES * 2];
static int spec_count = 0;

static volatile sig_atomic_t keep_running = 1;
static struct MHD_Daemon *http_daemon = NULL;

static pthread_mutex_t emit_mutex = PTHREAD_MUTEX_INITIALIZER;

// Playback state. Only one event train plays at a time; /play blocks until the
// train is done so the extension can simply await the HTTP response.
static pthread_mutex_t play_mutex = PTHREAD_MUTEX_INITIALIZER;
static volatile sig_atomic_t play_abort = 0;
static volatile bool playing = false;

// Keys/buttons this daemon currently holds down, so /stop can release them and
// never leave a stuck Ctrl or BTN_LEFT behind. EV_KEY covers KEY_* and BTN_*.
static pthread_mutex_t held_mutex = PTHREAD_MUTEX_INITIALIZER;
static unsigned char held[KEY_MAX + 1];
static int held_fd[KEY_MAX + 1];

static volatile bool recording = false;

// Event stream clients.
static pthread_mutex_t stream_mutex = PTHREAD_MUTEX_INITIALIZER;
static int stream_clients[MAX_STREAM_CLIENTS];
static int stream_client_count = 0;
static unsigned long long event_seq = 0;
static int event_listen_fd = -1;
static int control_listen_fd = -1;

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

static int emit(int fd, __u16 type, __u16 code, __s32 value) {
    struct input_event ev;

    memset(&ev, 0, sizeof(struct input_event));
    ev.type = type;
    ev.code = code;
    ev.value = value;
    gettimeofday(&ev.time, NULL);

    pthread_mutex_lock(&emit_mutex);
    int result = write(fd, &ev, sizeof(struct input_event));
    if (result < 0) {
        printf("[ERROR] Failed to emit event: %s\n", strerror(errno));
    }
    pthread_mutex_unlock(&emit_mutex);
    return result;
}

// emit() plus bookkeeping of held keys, used for injected events only.
static int emit_tracked(int fd, __u16 type, __u16 code, __s32 value) {
    int result = emit(fd, type, code, value);
    if (type == EV_KEY && code <= KEY_MAX) {
        pthread_mutex_lock(&held_mutex);
        if (value == 0) {
            held[code] = 0;
        } else {
            held[code] = 1;
            held_fd[code] = fd;
        }
        pthread_mutex_unlock(&held_mutex);
    }
    return result;
}

static void release_all_held(void) {
    pthread_mutex_lock(&held_mutex);
    for (int code = 0; code <= KEY_MAX; code++) {
        if (!held[code]) {
            continue;
        }
        int fd = held_fd[code];
        held[code] = 0;
        pthread_mutex_unlock(&held_mutex);

        printf("[DEBUG] Releasing stuck code %d\n", code);
        emit(fd, EV_KEY, code, 0);
        emit(fd, EV_SYN, SYN_REPORT, 0);

        pthread_mutex_lock(&held_mutex);
    }
    pthread_mutex_unlock(&held_mutex);
}

// ---------------------------------------------------------------------------
// Event stream (newline delimited JSON over a second unix socket)
// ---------------------------------------------------------------------------

static void stream_broadcast(int dev_index, const struct input_event *ev) {
    char line[192];
    long long t_us = (long long)ev->time.tv_sec * 1000000LL + (long long)ev->time.tv_usec;

    pthread_mutex_lock(&stream_mutex);
    unsigned long long seq = ++event_seq;
    int n = snprintf(line, sizeof(line),
                     "{\"seq\":%llu,\"t\":%lld,\"dev\":%d,\"type\":%u,\"code\":%u,\"value\":%d}\n",
                     seq, t_us, dev_index, ev->type, ev->code, ev->value);
    if (n < 0) {
        pthread_mutex_unlock(&stream_mutex);
        return;
    }
    if (n > (int)sizeof(line)) {
        n = (int)sizeof(line);
    }

    for (int i = 0; i < stream_client_count;) {
        ssize_t written = send(stream_clients[i], line, (size_t)n, MSG_NOSIGNAL | MSG_DONTWAIT);
        if (written < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
            printf("[DEBUG] Event stream client %d disconnected\n", stream_clients[i]);
            close(stream_clients[i]);
            stream_clients[i] = stream_clients[--stream_client_count];
            continue;
        }
        i++;
    }
    pthread_mutex_unlock(&stream_mutex);
}

static void* stream_accept_thread(void *arg) {
    (void)arg;
    while (keep_running) {
        int fd = accept(event_listen_fd, NULL, NULL);
        if (fd < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }

        pthread_mutex_lock(&stream_mutex);
        if (stream_client_count >= MAX_STREAM_CLIENTS) {
            pthread_mutex_unlock(&stream_mutex);
            printf("[DEBUG] Too many event stream clients, rejecting\n");
            close(fd);
            continue;
        }
        stream_clients[stream_client_count++] = fd;
        pthread_mutex_unlock(&stream_mutex);
        printf("[DEBUG] Event stream client connected (fd %d)\n", fd);
    }
    return NULL;
}

// ---------------------------------------------------------------------------
// Device capture
// ---------------------------------------------------------------------------

static bool has_bit(const unsigned int array[], int bit) {
    return (array[bit / 32] & (1U << (bit % 32))) != 0;
}

static bool setup_event_type(int fdi, int fdo, unsigned long event_type, int max_val, const unsigned int array_bit[]) {
    struct uinput_abs_setup abs_setup = {};
    bool abs_init_once = false;

    for (int i = 0; i < max_val; i++) {
        if (!(array_bit[i / 32] & (1U << (i % 32)))) {
            continue;
        }

        switch(event_type) {
            case UI_SET_EVBIT:
                if (ioctl(fdo, UI_SET_EVBIT, i) < 0) {
                    fprintf(stderr, "Cannot set EV bit %d: %s\n", i, strerror(errno));
                    return false;
                }
                break;
            case UI_SET_KEYBIT:
                if (ioctl(fdo, UI_SET_KEYBIT, i) < 0) {
                    fprintf(stderr, "Cannot set KEY bit %d: %s\n", i, strerror(errno));
                    return false;
                }
                break;
            case UI_SET_RELBIT:
                if (ioctl(fdo, UI_SET_RELBIT, i) < 0) {
                    fprintf(stderr, "Cannot set REL bit %d: %s\n", i, strerror(errno));
                    return false;
                }
                break;
            case UI_SET_ABSBIT:
                if (!abs_init_once) {
                    abs_setup.code = i;
                    if (ioctl(fdi, EVIOCGABS(i), &abs_setup.absinfo) < 0) {
                        fprintf(stderr, "Failed to get ABS info for axis %d: %s\n", i, strerror(errno));
                        continue;
                    }
                    if (ioctl(fdo, UI_ABS_SETUP, &abs_setup) < 0) {
                        fprintf(stderr, "Failed to setup ABS axis %d: %s\n", i, strerror(errno));
                        continue;
                    }
                    abs_init_once = true;
                }

                if (ioctl(fdo, UI_SET_ABSBIT, i) < 0) {
                    fprintf(stderr, "Cannot set ABS bit %d: %s\n", i, strerror(errno));
                    return false;
                }
                break;
            case UI_SET_MSCBIT:
                if (ioctl(fdo, UI_SET_MSCBIT, i) < 0) {
                    fprintf(stderr, "Cannot set MSC bit %d: %s\n", i, strerror(errno));
                    return false;
                }
                break;
        }
    }
    return true;
}

// Mirror the real device's capabilities onto the clone.
static bool mirror_capabilities(struct captured_device *d, int *cls_out) {
    unsigned int array_bit_ev[EV_MAX/32 + 1]   = {0},
                 array_bit_key[KEY_MAX/32 + 1] = {0},
                 array_bit_rel[REL_MAX/32 + 1] = {0},
                 array_bit_abs[ABS_MAX/32 + 1] = {0},
                 array_bit_msc[MSC_MAX/32 + 1] = {0};

    if (ioctl(d->fdi, EVIOCGBIT(0, sizeof(array_bit_ev)), &array_bit_ev) < 0) {
        fprintf(stderr, "Error: Failed to retrieve event capabilities for [%s]: %s.\n", d->path, strerror(errno));
        return false;
    }
    if (has_bit(array_bit_ev, EV_KEY) &&
        ioctl(d->fdi, EVIOCGBIT(EV_KEY, sizeof(array_bit_key)), &array_bit_key) < 0) {
        fprintf(stderr, "Error: Failed to retrieve EV_KEY capabilities for [%s]: %s.\n", d->path, strerror(errno));
        return false;
    }
    if (has_bit(array_bit_ev, EV_REL) &&
        ioctl(d->fdi, EVIOCGBIT(EV_REL, sizeof(array_bit_rel)), &array_bit_rel) < 0) {
        fprintf(stderr, "Error: Failed to retrieve EV_REL capabilities for [%s]: %s.\n", d->path, strerror(errno));
        return false;
    }
    if (has_bit(array_bit_ev, EV_ABS) &&
        ioctl(d->fdi, EVIOCGBIT(EV_ABS, sizeof(array_bit_abs)), &array_bit_abs) < 0) {
        fprintf(stderr, "Error: Failed to retrieve EV_ABS capabilities for [%s]: %s.\n", d->path, strerror(errno));
        return false;
    }
    if (has_bit(array_bit_ev, EV_MSC) &&
        ioctl(d->fdi, EVIOCGBIT(EV_MSC, sizeof(array_bit_msc)), &array_bit_msc) < 0) {
        fprintf(stderr, "Error: Failed to retrieve EV_MSC capabilities for [%s]: %s.\n", d->path, strerror(errno));
        return false;
    }

    // Classify: what can we sensibly inject into this device?
    int cls = 0;
    if (has_bit(array_bit_key, KEY_A) || has_bit(array_bit_key, KEY_ESC) || has_bit(array_bit_key, KEY_SPACE)) {
        cls |= CLASS_KEYBOARD;
    }
    if (has_bit(array_bit_key, BTN_LEFT) || has_bit(array_bit_rel, REL_X)) {
        cls |= CLASS_POINTER;
    }
    *cls_out = cls;

    if (!setup_event_type(d->fdi, d->fdo, UI_SET_EVBIT, EV_SW, array_bit_ev) ||
        !setup_event_type(d->fdi, d->fdo, UI_SET_KEYBIT, KEY_MAX, array_bit_key) ||
        !setup_event_type(d->fdi, d->fdo, UI_SET_RELBIT, REL_MAX, array_bit_rel) ||
        !setup_event_type(d->fdi, d->fdo, UI_SET_ABSBIT, ABS_MAX, array_bit_abs) ||
        !setup_event_type(d->fdi, d->fdo, UI_SET_MSCBIT, MSC_MAX, array_bit_msc)) {
        return false;
    }
    return true;
}

// On top of the mirrored capabilities, enable everything we might ever inject
// into a device of this class. Without this, injecting KEY_E into a mouse clone
// silently does nothing.
static bool add_injection_capabilities(int fdo, int cls) {
    if (ioctl(fdo, UI_SET_EVBIT, EV_SYN) < 0) {
        return false;
    }

    if (cls & CLASS_KEYBOARD) {
        if (ioctl(fdo, UI_SET_EVBIT, EV_KEY) < 0) {
            return false;
        }
        // All normal keys, skipping the BTN_* range so libinput keeps seeing a
        // keyboard rather than some keyboard/pointer chimera.
        for (int code = KEY_ESC; code <= KEY_MAX; code++) {
            if (code >= BTN_MISC && code < KEY_OK) {
                continue;
            }
            ioctl(fdo, UI_SET_KEYBIT, code);
        }
    }

    if (cls & CLASS_POINTER) {
        static const int buttons[] = {
            BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_SIDE, BTN_EXTRA, BTN_FORWARD, BTN_BACK, BTN_TASK
        };
        static const int axes[] = {
            REL_X, REL_Y, REL_WHEEL, REL_HWHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES
        };
        if (ioctl(fdo, UI_SET_EVBIT, EV_KEY) < 0 || ioctl(fdo, UI_SET_EVBIT, EV_REL) < 0) {
            return false;
        }
        for (size_t i = 0; i < sizeof(buttons) / sizeof(buttons[0]); i++) {
            ioctl(fdo, UI_SET_KEYBIT, buttons[i]);
        }
        for (size_t i = 0; i < sizeof(axes) / sizeof(axes[0]); i++) {
            ioctl(fdo, UI_SET_RELBIT, axes[i]);
        }
    }
    return true;
}

static bool create_clone(struct captured_device *d, const char *name, int forced_class) {
    struct uinput_setup usetup = {
        .id = { .bustype = BUS_USB, .vendor = 0x1111, .product = 0x3333 },
    };
    snprintf(usetup.name, sizeof(usetup.name), "%s", name);
    snprintf(d->name, sizeof(d->name), "%s", name);

    d->fdo = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (d->fdo < 0) {
        fprintf(stderr, "Error: Failed to open /dev/uinput: %s.\n", strerror(errno));
        return false;
    }

    // Every failure past this point closes fdo. A half-built clone used to be
    // harmless because the only caller gave up and exited; now that a failed
    // attach is retried on the next hotplug event, leaving it open would leak a
    // /dev/uinput descriptor per attempt.
    if (ioctl(d->fdo, UI_DEV_SETUP, &usetup) < 0) {
        fprintf(stderr, "Error: Failed to configure virtual device [%s]: %s.\n", name, strerror(errno));
        goto fail;
    }

    int cls = forced_class;
    if (d->fdi >= 0 && !mirror_capabilities(d, &cls)) {
        goto fail;
    }
    if (cls == 0) {
        // Unclassifiable real device: allow both so injection still has a home.
        cls = CLASS_KEYBOARD | CLASS_POINTER;
    }
    d->cls = cls;

    if (!add_injection_capabilities(d->fdo, cls)) {
        fprintf(stderr, "Error: Failed to add injection capabilities to [%s]: %s.\n", name, strerror(errno));
        goto fail;
    }

    if (ioctl(d->fdo, UI_DEV_CREATE) < 0) {
        fprintf(stderr, "Error: Cannot create virtual device [%s]: %s.\n", name, strerror(errno));
        goto fail;
    }

    usleep(200000); // let udev settle before anything writes to it
    return true;

fail:
    close(d->fdo);
    d->fdo = -1;
    return false;
}

static void* reader_thread(void *arg) {
    struct captured_device *d = arg;
    struct input_event ev = {0};

    printf("[DEBUG] Reader thread started for %s (fd %d -> %d)\n", d->path, d->fdi, d->fdo);

    while (keep_running) {
        ssize_t n = read(d->fdi, &ev, sizeof ev);

        if (n == (ssize_t) -1) {
            if (errno == EINTR) {
                continue;
            }
            perror("Error reading");
            break;
        } else if (n != sizeof ev) {
            fprintf(stderr, "Incomplete read on %s.\n", d->path);
            break;
        }

        // Always forward. Withholding real input would also withhold it from the
        // shell, which is what handles the emergency stop.
        if (d->grabbed) {
            emit(d->fdo, ev.type, ev.code, ev.value);
        }

        if (recording) {
            stream_broadcast(d->index, &ev);
        }
    }

    // Unplugging a device — or restarting whatever created it, which is what
    // happens every time dvorak is reconfigured upstream — makes read() fail
    // with ENODEV. Give the slot back so the monitor thread can reattach when
    // the device returns. The clone stays: injection through it keeps working,
    // and the desktop does not see the device node disappear and reappear.
    //
    // On shutdown release_devices() owns these fds — it runs from the signal
    // handler, where taking a mutex is not safe — so leave them alone here
    // rather than racing it into a double close.
    if (!keep_running) {
        return NULL;
    }

    pthread_mutex_lock(&devices_mutex);
    if (d->fdi >= 0) {
        ioctl(d->fdi, EVIOCGRAB, 0);
        close(d->fdi);
        d->fdi = -1;
    }
    d->grabbed = false;
    d->alive = false;
    pthread_mutex_unlock(&devices_mutex);

    fprintf(stderr, "clickmate: detached %s\n", d->path ? d->path : d->name);
    return NULL;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

static struct captured_device *device_for(unsigned int type, unsigned int code) {
    int want;
    if (type == EV_REL || type == EV_ABS) {
        want = CLASS_POINTER;
    } else if (type == EV_KEY && code >= BTN_MISC && code < KEY_OK) {
        want = CLASS_POINTER;
    } else if (type == EV_KEY) {
        want = CLASS_KEYBOARD;
    } else {
        want = 0;
    }

    // Injection goes to the clone, which outlives the real device, so a slot
    // whose source is currently unplugged is still a perfectly good target.
    struct captured_device *found = NULL;
    pthread_mutex_lock(&devices_mutex);

    if (want == 0) {
        found = device_count > 0 ? &devices[0] : NULL;
    }
    // Prefer a device dedicated to this class. Combined receivers (a Logitech
    // unifying mouse advertises KEY_ESC and so on) otherwise swallow every
    // keystroke into the mouse clone just because they come first.
    for (int i = 0; !found && i < device_count; i++) {
        if (devices[i].cls == want) {
            found = &devices[i];
        }
    }
    for (int i = 0; !found && i < device_count; i++) {
        if (devices[i].cls & want) {
            found = &devices[i];
        }
    }
    if (!found && device_count > 0) {
        found = &devices[0];
    }

    pthread_mutex_unlock(&devices_mutex);
    return found;
}

static void sleep_us_abortable(long long us) {
    const long long slice = 2000; // check the abort flag every 2ms
    while (us > 0 && !play_abort) {
        long long chunk = us > slice ? slice : us;
        usleep((useconds_t)chunk);
        us -= chunk;
    }
}

struct play_event {
    long long dt;   // microseconds to wait *before* emitting this event
    __u16 type;
    __u16 code;
    __s32 value;
    bool syn;       // emit SYN_REPORT afterwards
};

// Returns the number of events played, or -1 on error.
static long play_events(struct play_event *events, long count, bool *aborted) {
    long played = 0;
    *aborted = false;

    for (long i = 0; i < count; i++) {
        if (play_abort) {
            *aborted = true;
            break;
        }

        if (events[i].dt > 0) {
            sleep_us_abortable(events[i].dt);
            if (play_abort) {
                *aborted = true;
                break;
            }
        }

        struct captured_device *d = device_for(events[i].type, events[i].code);
        if (!d) {
            fprintf(stderr, "[ERROR] No device available for event type %u code %u\n",
                    events[i].type, events[i].code);
            return -1;
        }

        emit_tracked(d->fdo, events[i].type, events[i].code, events[i].value);
        if (events[i].syn) {
            emit(d->fdo, EV_SYN, SYN_REPORT, 0);
        }
        played++;
    }

    return played;
}

// ---------------------------------------------------------------------------
// HTTP control API
// ---------------------------------------------------------------------------

struct request_data {
    char *post_data;
    size_t size;
};

static enum MHD_Result send_json(struct MHD_Connection *connection, unsigned int code, const char *body) {
    struct MHD_Response *response = MHD_create_response_from_buffer(strlen(body),
                                                                   (void*)body,
                                                                   MHD_RESPMEM_MUST_COPY);
    MHD_add_response_header(response, "Content-Type", "application/json");
    enum MHD_Result ret = MHD_queue_response(connection, code, response);
    MHD_destroy_response(response);
    return ret;
}

static enum MHD_Result send_status(struct MHD_Connection *connection) {
    // Sized for MAX_DEVICES entries at their longest: a truncated object here
    // would be invalid JSON at the other end, not merely a shortened list.
    char body[3072];
    char devs[2560];
    size_t off = 0;

    devs[0] = '\0';
    pthread_mutex_lock(&devices_mutex);
    for (int i = 0; i < device_count && off < sizeof(devs) - 1; i++) {
        int n = snprintf(devs + off, sizeof(devs) - off,
                         "%s{\"index\":%d,\"name\":\"%s\",\"path\":\"%s\",\"grabbed\":%s,\"alive\":%s,\"wanted\":\"%s\",\"keyboard\":%s,\"pointer\":%s}",
                         i ? "," : "",
                         devices[i].index,
                         devices[i].name,
                         devices[i].path ? devices[i].path : "",
                         devices[i].grabbed ? "true" : "false",
                         devices[i].alive ? "true" : "false",
                         devices[i].wanted,
                         (devices[i].cls & CLASS_KEYBOARD) ? "true" : "false",
                         (devices[i].cls & CLASS_POINTER) ? "true" : "false");
        if (n < 0) {
            break;
        }
        off += (size_t)n;
    }
    pthread_mutex_unlock(&devices_mutex);

    snprintf(body, sizeof(body),
             "{\"version\":%d,\"recording\":%s,\"playing\":%s,\"devices\":[%s]}",
             API_VERSION,
             recording ? "true" : "false",
             playing ? "true" : "false",
             devs);

    return send_json(connection, MHD_HTTP_OK, body);
}

static enum MHD_Result handle_play(struct MHD_Connection *connection, struct json_object *parsed) {
    struct json_object *events_obj;
    if (!json_object_object_get_ex(parsed, "events", &events_obj) ||
        json_object_get_type(events_obj) != json_type_array) {
        return send_json(connection, MHD_HTTP_BAD_REQUEST, "{\"error\":\"missing events array\"}");
    }

    size_t count = json_object_array_length(events_obj);
    if (count == 0) {
        return send_json(connection, MHD_HTTP_OK, "{\"played\":0,\"aborted\":false}");
    }
    if (count > MAX_PLAY_EVENTS) {
        return send_json(connection, MHD_HTTP_BAD_REQUEST, "{\"error\":\"too many events\"}");
    }

    struct play_event *events = calloc(count, sizeof(struct play_event));
    if (!events) {
        return send_json(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "{\"error\":\"out of memory\"}");
    }

    for (size_t i = 0; i < count; i++) {
        struct json_object *e = json_object_array_get_idx(events_obj, i);
        struct json_object *field;

        events[i].dt = json_object_object_get_ex(e, "dt", &field) ? json_object_get_int64(field) : 0;
        events[i].type = json_object_object_get_ex(e, "type", &field) ? (__u16)json_object_get_int(field) : 0;
        events[i].code = json_object_object_get_ex(e, "code", &field) ? (__u16)json_object_get_int(field) : 0;
        events[i].value = json_object_object_get_ex(e, "value", &field) ? (__s32)json_object_get_int(field) : 0;
        events[i].syn = json_object_object_get_ex(e, "syn", &field) ? json_object_get_boolean(field) : true;

        if (events[i].dt < 0) {
            events[i].dt = 0;
        }
    }

    if (pthread_mutex_trylock(&play_mutex) != 0) {
        free(events);
        return send_json(connection, MHD_HTTP_CONFLICT, "{\"error\":\"busy\"}");
    }

    play_abort = 0;
    playing = true;
    bool aborted = false;
    long played = play_events(events, (long)count, &aborted);
    playing = false;
    pthread_mutex_unlock(&play_mutex);
    free(events);

    if (played < 0) {
        return send_json(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "{\"error\":\"no suitable device\"}");
    }

    char body[128];
    snprintf(body, sizeof(body), "{\"played\":%ld,\"aborted\":%s}", played, aborted ? "true" : "false");
    return send_json(connection, MHD_HTTP_OK, body);
}

static enum MHD_Result handle_post(struct MHD_Connection *connection, const char *url, const char *data) {
    struct json_object *parsed = data ? json_tokener_parse(data) : NULL;
    struct json_object *field;
    enum MHD_Result ret;

    if (strcmp(url, "/play") == 0) {
        if (!parsed) {
            return send_json(connection, MHD_HTTP_BAD_REQUEST, "{\"error\":\"invalid json\"}");
        }
        ret = handle_play(connection, parsed);
        json_object_put(parsed);
        return ret;
    }

    if (strcmp(url, "/stop") == 0) {
        play_abort = 1;
        release_all_held();
        if (parsed) {
            json_object_put(parsed);
        }
        return send_json(connection, MHD_HTTP_OK, "{\"stopped\":true}");
    }

    if (strcmp(url, "/record") == 0) {
        bool on = parsed && json_object_object_get_ex(parsed, "on", &field) && json_object_get_boolean(field);
        recording = on;
        printf("[DEBUG] Recording %s\n", on ? "started" : "stopped");
        if (parsed) {
            json_object_put(parsed);
        }
        return send_json(connection, MHD_HTTP_OK, on ? "{\"recording\":true}" : "{\"recording\":false}");
    }

    if (parsed) {
        json_object_put(parsed);
    }
    return send_json(connection, MHD_HTTP_NOT_FOUND, "{\"error\":\"unknown endpoint\"}");
}

static enum MHD_Result handle_request(void *cls,
                                      struct MHD_Connection *connection,
                                      const char *url,
                                      const char *method,
                                      const char *version,
                                      const char *upload_data,
                                      size_t *upload_data_size,
                                      void **con_cls) {
    (void)cls; (void)version;

    if (*con_cls == NULL) {
        struct request_data *data = calloc(1, sizeof(struct request_data));
        if (!data) {
            return MHD_NO;
        }
        *con_cls = data;
        return MHD_YES;
    }

    struct request_data *req_data = *con_cls;

    if (strcmp(method, "GET") == 0) {
        printf("[DEBUG] GET %s\n", url);
        return send_status(connection);
    }

    if (strcmp(method, "POST") == 0) {
        if (*upload_data_size > 0) {
            char *grown = realloc(req_data->post_data, req_data->size + *upload_data_size + 1);
            if (!grown) {
                return MHD_NO;
            }
            req_data->post_data = grown;
            memcpy(req_data->post_data + req_data->size, upload_data, *upload_data_size);
            req_data->size += *upload_data_size;
            req_data->post_data[req_data->size] = '\0';

            *upload_data_size = 0;
            return MHD_YES;
        }

        printf("[DEBUG] POST %s (%zu bytes)\n", url, req_data->size);
        return handle_post(connection, url, req_data->post_data);
    }

    return send_json(connection, MHD_HTTP_METHOD_NOT_ALLOWED, "{\"error\":\"Method not allowed\"}");
}

static void request_completed(void *cls, struct MHD_Connection *connection,
                              void **con_cls, enum MHD_RequestTerminationCode toe) {
    (void)cls; (void)connection; (void)toe;
    struct request_data *req_data = *con_cls;
    if (req_data) {
        free(req_data->post_data);
        free(req_data);
        *con_cls = NULL;
    }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

// Closing the grabbed fds is what hands input back to the desktop, so it has to
// happen even on a crash. close() is async-signal-safe.
static void release_devices(void) {
    for (int i = 0; i < device_count; i++) {
        if (devices[i].fdi >= 0) {
            ioctl(devices[i].fdi, EVIOCGRAB, 0);
            close(devices[i].fdi);
            devices[i].fdi = -1;
        }
    }
}

static void sig_handler(int sig) {
    keep_running = 0;
    play_abort = 1;
    release_devices();

    if (sig == SIGSEGV || sig == SIGABRT) {
        _exit(EXIT_FAILURE);
    }
}

static int create_unix_listener(const char *path) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd == -1) {
        perror("socket");
        return -1;
    }

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);

    unlink(path);

    if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) == -1) {
        perror("bind");
        close(fd);
        return -1;
    }
    if (listen(fd, 5) == -1) {
        perror("listen");
        close(fd);
        unlink(path);
        return -1;
    }

    chmod(path, 0666);
    return fd;
}

static void usage(const char *path) {
    const char *basename = strrchr(path, '/');
    basename = basename ? basename + 1 : path;

    fprintf(stderr, "usage: %s [-d PATH] [-n NAME] …\n", basename);
    fprintf(stderr, "  -d PATH\tCapture the device at this path.\n");
    fprintf(stderr, "  -n NAME\tCapture every device with this exact name (case-insensitive).\n");
    fprintf(stderr, "         \tUse this for receiver-paired devices, which have no stable\n");
    fprintf(stderr, "         \tpath under /dev/input/by-id. Names are listed by:\n");
    fprintf(stderr, "         \t  grep '^N: Name' /proc/bus/input/devices\n");
    fprintf(stderr, "  At most %d devices in total.\n", MAX_DEVICES);
    fprintf(stderr, "\nDevices do not have to exist at startup: /dev/input is watched, and\n");
    fprintf(stderr, "anything matching is captured when it appears and reattached when it\n");
    fprintf(stderr, "comes back after being unplugged.\n");
    fprintf(stderr, "example: %s -n 'Logitech K400 Plus' -d /dev/input/by-id/usb-…-event-kbd\n", basename);
}

static void start_reader(struct captured_device *d) {
    if (pthread_create(&d->reader, NULL, reader_thread, d) != 0) {
        fprintf(stderr, "Error: Failed to start reader thread for %s\n", d->path);
        return;
    }
    // Nothing ever joins a reader: one device can come and go many times in a
    // session, and every reattach starts a fresh thread.
    pthread_detach(d->reader);
}

// Caller holds devices_mutex.
static bool setup_device(const char *path, const char *wanted) {
    struct captured_device *d = &devices[device_count];
    memset(d, 0, sizeof(*d));
    d->index = device_count;
    d->path = strdup(path);
    snprintf(d->wanted, sizeof(d->wanted), "%s", wanted);
    d->fdi = open(path, O_RDONLY);
    if (d->fdi < 0) {
        fprintf(stderr, "Error: Failed to open device [%s]: %s.\n", path, strerror(errno));
        fprintf(stderr, "Hint: Check the device path and that you have permission to read it.\n");
        free(d->path);
        d->path = NULL;
        return false;
    }

    char clone_name[64];
    snprintf(clone_name, sizeof(clone_name), "Clickmate Virtual Device %d", device_count);
    if (!create_clone(d, clone_name, 0)) {
        close(d->fdi);
        d->fdi = -1;
        free(d->path);
        d->path = NULL;
        return false;
    }

    if (ioctl(d->fdi, EVIOCGRAB, 1) < 0) {
        // Without an exclusive grab, forwarding would duplicate every event, so
        // fall back to observe-only: recording still works, injection still works.
        fprintf(stderr, "Warning: Cannot grab [%s]: %s. Running observe-only for this device.\n",
                path, strerror(errno));
        d->grabbed = false;
    } else {
        d->grabbed = true;
    }

    // stderr, not stdout: the unit sends stdout to /dev/null, and what was
    // actually captured is the first thing you want to see when a device turns
    // out to be missing.
    fprintf(stderr, "clickmate: captured %s%s%s%s\n",
            path,
            d->grabbed ? "" : " (not grabbed)",
            (d->cls & CLASS_KEYBOARD) ? " [keys]" : "",
            (d->cls & CLASS_POINTER) ? " [pointer]" : "");

    d->alive = true;
    device_count++;
    return true;
}

/**
 * Bind one device node to a slot. A device that was captured before and has
 * since gone away keeps its slot, so plugging it back in resumes where it left
 * off instead of consuming a second slot.
 *
 * Caller holds devices_mutex.
 */
static bool attach_device(const char *path, const char *wanted) {
    for (int i = 0; i < device_count; i++) {
        if (devices[i].alive && devices[i].path && strcmp(devices[i].path, path) == 0) {
            return false;
        }
    }

    for (int i = 0; i < device_count; i++) {
        struct captured_device *d = &devices[i];
        if (d->alive || d->wanted[0] == '\0' || strcmp(d->wanted, wanted) != 0) {
            continue;
        }

        int fd = open(path, O_RDONLY);
        if (fd < 0) {
            return false;
        }

        free(d->path);
        d->path = strdup(path);
        d->fdi = fd;

        if (ioctl(fd, EVIOCGRAB, 1) < 0) {
            fprintf(stderr, "Warning: Cannot grab [%s]: %s. Running observe-only for this device.\n",
                    path, strerror(errno));
            d->grabbed = false;
        } else {
            d->grabbed = true;
        }

        // The clone is deliberately not rebuilt. A device returning under the
        // same name reports the same capabilities, and tearing the clone down
        // would make the desktop lose and re-find the input device — and lose
        // any modifier state along with it — on every reconnect.
        d->alive = true;
        fprintf(stderr, "clickmate: reattached %s as %s%s\n",
                path, d->name, d->grabbed ? "" : " (not grabbed)");
        start_reader(d);
        return true;
    }

    if (device_count >= MAX_DEVICES) {
        fprintf(stderr, "Warning: no slot left for %s (limit is %d devices).\n", path, MAX_DEVICES);
        return false;
    }
    if (!setup_device(path, wanted)) {
        return false;
    }
    start_reader(&devices[device_count - 1]);
    return true;
}

#define MAX_SCAN 64

struct scan_entry {
    char path[288];
    char name[256];
};

static int compare_scan(const void *a, const void *b) {
    return strcmp(((const struct scan_entry *)a)->path, ((const struct scan_entry *)b)->path);
}

/**
 * Match every node in /dev/input against what was asked for and attach whatever
 * is missing. Devices paired through a wireless receiver get no
 * /dev/input/by-id entry, so a path is not something you can rely on for them;
 * the name is.
 *
 * Called once at startup and again whenever a device node appears, which is
 * what makes the daemon indifferent to whether it started before or after the
 * devices it wants.
 */
static void rescan(bool verbose) {
    // Only ever entered from main before the threads exist and from the single
    // monitor thread after that, so static storage is safe here and keeps 35 KB
    // off the stack.
    static struct scan_entry found[MAX_SCAN];
    int found_count = 0;

    DIR *dir = opendir("/dev/input");
    if (!dir) {
        perror("opendir /dev/input");
        return;
    }

    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL && found_count < MAX_SCAN) {
        if (strncmp(entry->d_name, "event", 5) != 0) {
            continue;
        }

        struct scan_entry *e = &found[found_count];
        snprintf(e->path, sizeof(e->path), "/dev/input/%s", entry->d_name);

        int fd = open(e->path, O_RDONLY);
        if (fd < 0) {
            continue;
        }
        e->name[0] = '\0';
        bool named = ioctl(fd, EVIOCGNAME(sizeof(e->name) - 1), e->name) >= 0;
        close(fd);

        // Never look at our own clones: capturing one would feed every event
        // straight back into itself.
        if (named && strncmp(e->name, "Clickmate", 9) != 0) {
            found_count++;
        }
    }
    closedir(dir);

    // readdir order is arbitrary; sort so that two devices sharing a name — the
    // two halves of a keyboard, say — always land in the same slots.
    qsort(found, found_count, sizeof(found[0]), compare_scan);

    for (int s = 0; s < spec_count; s++) {
        int matched = 0;

        pthread_mutex_lock(&devices_mutex);
        for (int i = 0; i < found_count; i++) {
            bool hit = specs[s].by_name
                ? strcasecmp(found[i].name, specs[s].value) == 0
                : strcmp(found[i].path, specs[s].value) == 0;
            if (hit) {
                matched++;
                attach_device(found[i].path, specs[s].value);
            }
        }
        // A -d path is often a by-id symlink, which the scan above never sees.
        if (!specs[s].by_name && matched == 0 && access(specs[s].value, R_OK) == 0) {
            matched += attach_device(specs[s].value, specs[s].value) ? 1 : 0;
        }
        pthread_mutex_unlock(&devices_mutex);

        if (matched == 0 && verbose) {
            if (specs[s].by_name) {
                fprintf(stderr, "Warning: no input device is named \"%s\" yet. Waiting for it.\n",
                        specs[s].value);
                fprintf(stderr, "Hint: grep '^N: Name' /proc/bus/input/devices\n");
            } else {
                fprintf(stderr, "Warning: no device at %s yet. Waiting for it.\n", specs[s].value);
            }
        }
    }
}

/**
 * Watch /dev/input so a device that turns up later gets captured without
 * restarting the daemon: a wireless mouse that pairs seconds into boot, or a
 * keyboard whose upstream remapper was reconfigured and rebuilt its virtual
 * device. Without this the daemon's view of the world is fixed at the instant
 * it started, and losing that race is silent — a warning in the journal and a
 * macro that does nothing.
 */
static void *monitor_thread(void *arg) {
    (void)arg;

    int fd = inotify_init1(IN_NONBLOCK);
    if (fd < 0) {
        perror("inotify_init1");
        fprintf(stderr, "Warning: hotplug disabled; devices are captured at startup only.\n");
        return NULL;
    }

    // IN_ATTRIB as well as IN_CREATE: udev sets permissions after the node
    // appears, so an open can lose that race and the chmod is the second chance.
    if (inotify_add_watch(fd, "/dev/input", IN_CREATE | IN_ATTRIB) < 0) {
        perror("inotify_add_watch /dev/input");
        close(fd);
        return NULL;
    }

    char buf[4096] __attribute__((aligned(__alignof__(struct inotify_event))));

    while (keep_running) {
        struct pollfd pfd = { .fd = fd, .events = POLLIN, .revents = 0 };
        // Poll rather than block, so a quiet /dev/input does not hold up
        // shutdown for as long as nobody touches a keyboard.
        if (poll(&pfd, 1, 1000) <= 0) {
            continue;
        }

        // The queued events are drained but not read: a full rescan costs one
        // pass over ~30 device nodes and cannot miss anything that slipped
        // through while the queue was overflowing.
        while (read(fd, buf, sizeof buf) > 0) {
        }

        // The node exists before udev has finished with it; grabbing this early
        // works but the capability mirroring can come up short.
        usleep(150000);
        rescan(false);
    }

    close(fd);
    return NULL;
}

// If no captured device can carry a whole device class, add an ungrabbed uinput
// device for it so single-device setups can still replay everything.
static bool ensure_class(int cls, const char *name) {
    for (int i = 0; i < device_count; i++) {
        if (devices[i].cls & cls) {
            return true;
        }
    }
    if (device_count >= MAX_DEVICES) {
        fprintf(stderr, "Error: no slot left for %s\n", name);
        return false;
    }

    struct captured_device *d = &devices[device_count];
    memset(d, 0, sizeof(*d));
    d->index = device_count;
    d->fdi = -1;
    d->path = NULL;
    d->grabbed = false;

    if (!create_clone(d, name, cls)) {
        return false;
    }

    printf("[DEBUG] Created synthetic device %s\n", name);
    device_count++;
    return true;
}

int main(int argc, char *argv[]) {
    printf("[DEBUG] Starting clickmate input service (API v%d)\n", API_VERSION);

    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, sig_handler);
    signal(SIGINT, sig_handler);
    signal(SIGSEGV, sig_handler);
    signal(SIGABRT, sig_handler);

    int opt;

    while ((opt = getopt(argc, argv, "d:n:h")) != -1) {
        switch (opt) {
            case 'd':
            case 'n':
                if (spec_count >= (int)(sizeof(specs) / sizeof(specs[0]))) {
                    fprintf(stderr, "Error: too many devices requested.\n");
                    return EXIT_FAILURE;
                }
                specs[spec_count].by_name = (opt == 'n');
                specs[spec_count].value = optarg;
                spec_count++;
                break;
            case 'h':
                usage(argv[0]);
                return EXIT_SUCCESS;
            default:
                usage(argv[0]);
                return EXIT_FAILURE;
        }
    }

    if (spec_count == 0) {
        usage(argv[0]);
        fprintf(stderr, "Error: no input device specified.\n");
        return EXIT_FAILURE;
    }

    // A device that is not there is a warning, not a failure. It may simply not
    // have appeared yet — a wireless mouse pairing, or an upstream remapper
    // still building the virtual keyboard this daemon sits behind — and the
    // monitor thread picks it up whenever it does show up.
    rescan(true);

    if (device_count == 0) {
        fprintf(stderr, "Warning: nothing captured yet. Waiting for the requested devices.\n");
    }

    if (!ensure_class(CLASS_KEYBOARD, "Clickmate Virtual Keyboard") ||
        !ensure_class(CLASS_POINTER, "Clickmate Virtual Mouse")) {
        release_devices();
        return EXIT_FAILURE;
    }

    control_listen_fd = create_unix_listener(SOCKET_PATH);
    if (control_listen_fd < 0) {
        release_devices();
        return EXIT_FAILURE;
    }

    event_listen_fd = create_unix_listener(EVENT_SOCKET_PATH);
    if (event_listen_fd < 0) {
        close(control_listen_fd);
        unlink(SOCKET_PATH);
        release_devices();
        return EXIT_FAILURE;
    }

    http_daemon = MHD_start_daemon(MHD_USE_THREAD_PER_CONNECTION | MHD_USE_INTERNAL_POLLING_THREAD,
                                   0,
                                   NULL, NULL,
                                   &handle_request, NULL,
                                   MHD_OPTION_LISTEN_SOCKET, control_listen_fd,
                                   MHD_OPTION_NOTIFY_COMPLETED, &request_completed, NULL,
                                   MHD_OPTION_END);
    if (http_daemon == NULL) {
        fprintf(stderr, "Failed to start HTTP daemon\n");
        close(control_listen_fd);
        close(event_listen_fd);
        unlink(SOCKET_PATH);
        unlink(EVENT_SOCKET_PATH);
        release_devices();
        return EXIT_FAILURE;
    }

    pthread_t stream_thread;
    pthread_create(&stream_thread, NULL, stream_accept_thread, NULL);

    // Readers are started by attach_device(), so devices captured during
    // rescan() above are already running by now.
    pthread_t hotplug_thread;
    pthread_create(&hotplug_thread, NULL, monitor_thread, NULL);

    printf("[DEBUG] Listening on %s and %s\n", SOCKET_PATH, EVENT_SOCKET_PATH);

    while (keep_running) {
        pause();
    }

    printf("[DEBUG] Shutting down\n");
    release_all_held();
    MHD_stop_daemon(http_daemon);
    close(event_listen_fd);
    unlink(SOCKET_PATH);
    unlink(EVENT_SOCKET_PATH);
    release_devices();

    for (int i = 0; i < device_count; i++) {
        if (devices[i].fdo >= 0) {
            ioctl(devices[i].fdo, UI_DEV_DESTROY);
            close(devices[i].fdo);
        }
        free(devices[i].path);
    }

    return EXIT_SUCCESS;
}
