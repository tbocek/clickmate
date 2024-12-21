#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <stdlib.h>
#include <math.h>

#define MAX_MOUSE_HISTORY 2
#define MOUSE_MULTIPLIER 2.0

struct mouse_movement {
    float x;
    float y;
};

struct gamepad_state {
    struct input_event axes[4];  // Left stick X/Y (0,1), Right stick X/Y (2,3)
    struct input_event buttons[17];  // Matches the JS mapping
    int button_states[17];  // Track button press states
};

static struct mouse_movement mouse_history[MAX_MOUSE_HISTORY];
static int mouse_history_count = 0;

float normalize_movement(int movement) {
    if (movement == 0) return 0;

    float result = log2f(abs(movement)) / 6.8f + 0.1f;
    return movement < 0 ? -result : result;
}

void update_mouse_history(int movement_x, int movement_y) {
    // Shift history
    for (int i = MAX_MOUSE_HISTORY - 1; i > 0; i--) {
        mouse_history[i] = mouse_history[i-1];
    }

    // Add new movement
    if (movement_x == 0 && movement_y == 0) {
        mouse_history_count = 0;
    } else {
        mouse_history[0].x = normalize_movement(movement_x);
        mouse_history[0].y = normalize_movement(movement_y);
        mouse_history_count = mouse_history_count < MAX_MOUSE_HISTORY ?
                              mouse_history_count + 1 : MAX_MOUSE_HISTORY;
    }
}

void get_smooth_movement(float *x, float *y) {
    if (mouse_history_count == 0) {
        *x = 0;
        *y = 0;
        return;
    }

    float acc_x = 0, acc_y = 0;
    for (int i = 0; i < mouse_history_count; i++) {
        acc_x += mouse_history[i].x;
        acc_y += mouse_history[i].y;
    }

    *x = (acc_x / mouse_history_count) * MOUSE_MULTIPLIER;
    *y = (acc_y / mouse_history_count) * MOUSE_MULTIPLIER;
}

static int emit(int fd, struct input_event *ev) {
    return write(fd, ev, sizeof(struct input_event));
}

void setup_gamepad(int fd) {
    struct uinput_setup usetup;
    memset(&usetup, 0, sizeof(usetup));
    strncpy(usetup.name, "Keyboard/Mouse Gamepad", UINPUT_MAX_NAME_SIZE);
    usetup.id.bustype = BUS_USB;
    usetup.id.vendor = 0x1234;
    usetup.id.product = 0x5678;
    usetup.id.version = 1;

    // Enable gamepad events
    ioctl(fd, UI_SET_EVBIT, EV_KEY);
    ioctl(fd, UI_SET_EVBIT, EV_ABS);
    ioctl(fd, UI_SET_EVBIT, EV_SYN);

    // Setup buttons (BTN_GAMEPAD to BTN_THUMBR)
    for (int i = BTN_GAMEPAD; i <= BTN_THUMBR; i++) {
        ioctl(fd, UI_SET_KEYBIT, i);
    }

    // Setup axes
    struct uinput_abs_setup abs_setup;
    memset(&abs_setup, 0, sizeof(abs_setup));

    // Left/Right stick X/Y
    for (int i = ABS_X; i <= ABS_RY; i++) {
        ioctl(fd, UI_SET_ABSBIT, i);
        abs_setup.code = i;
        abs_setup.absinfo.minimum = -32768;
        abs_setup.absinfo.maximum = 32767;
        abs_setup.absinfo.fuzz = 16;
        abs_setup.absinfo.flat = 128;
        ioctl(fd, UI_ABS_SETUP, &abs_setup);
    }

    ioctl(fd, UI_DEV_SETUP, &usetup);
    ioctl(fd, UI_DEV_CREATE);
}

void handle_keyboard_event(struct input_event *ev, struct gamepad_state *state, int fd) {
    // Map keyboard keys to gamepad buttons
    switch (ev->code) {
        case KEY_E:  // A button
            state->button_states[0] = ev->value;
            state->buttons[0].value = ev->value;
            emit(fd, &state->buttons[0]);
            break;
        case KEY_C:  // B button
        case KEY_ESC:
            state->button_states[1] = ev->value;
            state->buttons[1].value = ev->value;
            emit(fd, &state->buttons[1]);
            break;
            // Add more key mappings following your JS configuration
        case KEY_W:  // Left stick up
            state->axes[1].value = ev->value ? -32767 : 0;
            emit(fd, &state->axes[1]);
            break;
        case KEY_S:  // Left stick down
            state->axes[1].value = ev->value ? 32767 : 0;
            emit(fd, &state->axes[1]);
            break;
        case KEY_A:  // Left stick left
            state->axes[0].value = ev->value ? -32767 : 0;
            emit(fd, &state->axes[0]);
            break;
        case KEY_D:  // Left stick right
            state->axes[0].value = ev->value ? 32767 : 0;
            emit(fd, &state->axes[0]);
            break;
    }
}

void handle_mouse_event(struct input_event *ev, struct gamepad_state *state, int fd) {
    static int mouse_x = 0, mouse_y = 0;

    if (ev->type == EV_REL) {
        switch (ev->code) {
            case REL_X:
                mouse_x = ev->value;
                break;
            case REL_Y:
                mouse_y = ev->value;
                break;
        }

        update_mouse_history(mouse_x, mouse_y);
        float smooth_x, smooth_y;
        get_smooth_movement(&smooth_x, &smooth_y);

        // Update right stick axes
        state->axes[2].value = (int)(smooth_x * 32767);
        state->axes[3].value = (int)(smooth_y * 32767);

        emit(fd, &state->axes[2]);
        emit(fd, &state->axes[3]);
    } else if (ev->type == EV_KEY) {
        switch (ev->code) {
            case BTN_LEFT:  // R2
                state->button_states[7] = ev->value;
                state->buttons[7].value = ev->value;
                emit(fd, &state->buttons[7]);
                break;
            case BTN_RIGHT:  // L2
                state->button_states[6] = ev->value;
                state->buttons[6].value = ev->value;
                emit(fd, &state->buttons[6]);
                break;
            case BTN_MIDDLE:  // R3
                state->button_states[11] = ev->value;
                state->buttons[11].value = ev->value;
                emit(fd, &state->buttons[11]);
                break;
        }
    }
}

int main(int argc, char *argv[]) {
    if (argc != 3) {
        fprintf(stderr, "Usage: %s <keyboard device> <mouse device>\n", argv[0]);
        return EXIT_FAILURE;
    }

    int keyboard_fd = open(argv[1], O_RDONLY);
    int mouse_fd = open(argv[2], O_RDONLY);
    int gamepad_fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);

    if (keyboard_fd < 0 || mouse_fd < 0 || gamepad_fd < 0) {
        perror("Failed to open input devices");
        return EXIT_FAILURE;
    }

    // Grab input devices
    ioctl(keyboard_fd, EVIOCGRAB, 1);
    ioctl(mouse_fd, EVIOCGRAB, 1);

    // Setup virtual gamepad
    setup_gamepad(gamepad_fd);

    // Initialize gamepad state
    struct gamepad_state state;
    memset(&state, 0, sizeof(state));

    // Set up event types
    for (int i = 0; i < 4; i++) {
        state.axes[i].type = EV_ABS;
        state.axes[i].code = ABS_X + i;
    }
    for (int i = 0; i < 17; i++) {
        state.buttons[i].type = EV_KEY;
        state.buttons[i].code = BTN_GAMEPAD + i;
    }

    // Main event loop
    struct input_event ev;
    fd_set fds;
    int max_fd = (keyboard_fd > mouse_fd ? keyboard_fd : mouse_fd) + 1;

    while (1) {
        FD_ZERO(&fds);
        FD_SET(keyboard_fd, &fds);
        FD_SET(mouse_fd, &fds);

        if (select(max_fd, &fds, NULL, NULL, NULL) < 0) {
            perror("select");
            break;
        }

        if (FD_ISSET(keyboard_fd, &fds)) {
            if (read(keyboard_fd, &ev, sizeof(ev)) == sizeof(ev)) {
                handle_keyboard_event(&ev, &state, gamepad_fd);
            }
        }

        if (FD_ISSET(mouse_fd, &fds)) {
            if (read(mouse_fd, &ev, sizeof(ev)) == sizeof(ev)) {
                handle_mouse_event(&ev, &state, gamepad_fd);
            }
        }

        // Sync events
        struct input_event sync_ev;
        memset(&sync_ev, 0, sizeof(sync_ev));
        sync_ev.type = EV_SYN;
        sync_ev.code = SYN_REPORT;
        emit(gamepad_fd, &sync_ev);
    }

    // Cleanup
    ioctl(keyboard_fd, EVIOCGRAB, 0);
    ioctl(mouse_fd, EVIOCGRAB, 0);
    close(keyboard_fd);
    close(mouse_fd);
    ioctl(gamepad_fd, UI_DEV_DESTROY);
    close(gamepad_fd);

    return EXIT_SUCCESS;
}