#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <stdlib.h>
#include <errno.h>
#include <time.h>
#include <pthread.h>
#include <stdbool.h>
#include <signal.h>
#include <microhttpd.h>
#include <json-c/json.h>
#include <sys/un.h>
#include <sys/stat.h>

#define SOCKET_PATH "/var/run/click-socket"
#define BUFFER_SIZE 1024

// Thread control variables
pthread_t thread_id = 0;
bool thread_active = false;
pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
pthread_mutex_t emit_mutex = PTHREAD_MUTEX_INITIALIZER;

static volatile sig_atomic_t keep_running = 1;
static struct MHD_Daemon *http_daemon = NULL;
static int fdo = -1;  // Store file descriptor for click events
static int fdi = -1;

static int emit(int fd, __u16 type, __u16 code, __s32 value) {
    struct input_event ev;

    memset(&ev, 0, sizeof(struct input_event));
    ev.type = type;
    ev.code = code;
    ev.value = value;
    gettimeofday(&ev.time, NULL);

    // Lock the mutex
    pthread_mutex_lock(&emit_mutex);
    int result = write(fd, &ev, sizeof(struct input_event));
    if (result < 0) {
        printf("[ERROR] Failed to emit event: %s\n", strerror(errno));
    }
    // Unlock the mutex
    pthread_mutex_unlock(&emit_mutex);
    return result;
}

void* click(void *arg) {
    printf("[DEBUG] Click thread started with fd: %d\n", fdo);
    while (1) {
        pthread_mutex_lock(&lock);
        if (!thread_active) {
            printf("[DEBUG] Click thread stopping\n");
            pthread_mutex_unlock(&lock);
            break; // Exit the loop if thread_active is false
        }
        pthread_mutex_unlock(&lock);

        printf("[DEBUG] Performing click cycle\n");

        // Emit the mouse press event (left button)
        emit(fdo, EV_KEY, BTN_LEFT, 1); // Button press
        emit(fdo, EV_SYN, SYN_REPORT, 0); // Sync report

        usleep(100 * 1000); // Wait 100 milliseconds

        // Emit the mouse release event (left button)
        emit(fdo, EV_KEY, BTN_LEFT, 0); // Button release
        emit(fdo, EV_SYN, SYN_REPORT, 0); // Sync report

        usleep(100 * 1000);
    }
    return NULL;
}

void startClickThread() {
    printf("[DEBUG] Attempting to start click thread\n");

    pthread_mutex_lock(&lock);
    if (thread_active) {
        printf("[DEBUG] Thread already active, not starting new thread\n");
        pthread_mutex_unlock(&lock);
        return;
    }
    thread_active = true;
    pthread_mutex_unlock(&lock);

    int result = pthread_create(&thread_id, NULL, click, NULL);
    if (result != 0) {
        printf("[ERROR] Failed to create click thread: %s\n", strerror(result));
    } else {
        printf("[DEBUG] Click thread created successfully\n");
    }
}

void stopClickThread() {
    printf("[DEBUG] Attempting to stop click thread\n");

    pthread_mutex_lock(&lock);
    if (!thread_active) {
        printf("[DEBUG] Thread not active, nothing to stop\n");
        pthread_mutex_unlock(&lock);
        return;
    }
    thread_active = false;
    pthread_mutex_unlock(&lock);

    int result = pthread_join(thread_id, NULL);
    if (result != 0) {
        printf("[ERROR] Failed to join click thread: %s\n", strerror(result));
    } else {
        printf("[DEBUG] Click thread stopped successfully\n");
    }
}

// Structure to accumulate POST data
struct connection_info_struct {
    char *data;
    size_t size;
};

static const char* get_status_json() {
    bool is_active = false;
    pthread_mutex_lock(&lock);
    is_active = thread_active;
    pthread_mutex_unlock(&lock);

    return is_active ? "{\"status\":\"on\"}" : "{\"status\":\"off\"}";
}

// Main request handler
static enum MHD_Result handle_request(void *cls,
                          struct MHD_Connection *connection,
                          const char *url,
                          const char *method,
                          const char *version,
                          const char *upload_data,
                          size_t *upload_data_size,
                          void **con_cls) {

    printf("[DEBUG] Received HTTP request - Method: %s, URL: %s\n", method, url);

    struct MHD_Response *response;
    enum MHD_Result ret = MHD_YES;

    // Track POST session state
    struct RequestData {
        char *post_data;
        size_t size;
    };

    if (*con_cls == NULL) {  // Initialize session data
        struct RequestData *data = calloc(1, sizeof(struct RequestData));
        data->post_data = NULL;
        data->size = 0;
        *con_cls = data;
        return MHD_YES;
    }

    struct RequestData *req_data = *con_cls;

    if (strcmp(method, "GET") == 0) {
        printf("[DEBUG] Processing GET request\n");

        // Return current status
        const char *status_json = get_status_json();
        printf("[DEBUG] Returning status: %s\n", status_json);
        response = MHD_create_response_from_buffer(strlen(status_json),
                                                   (void*)status_json,
                                                   MHD_RESPMEM_MUST_COPY);
        MHD_add_response_header(response, "Content-Type", "application/json");
        ret = MHD_queue_response(connection, MHD_HTTP_OK, response);
        MHD_destroy_response(response);

        return ret;
    }

    // Handle POST request
    if (strcmp(method, "POST") == 0) {
        if (*upload_data_size > 0) {
            // Accumulate data
            req_data->post_data = realloc(req_data->post_data, req_data->size + *upload_data_size + 1);
            memcpy(req_data->post_data + req_data->size, upload_data, *upload_data_size);
            req_data->size += *upload_data_size;
            req_data->post_data[req_data->size] = '\0';

            *upload_data_size = 0;  // Indicate processed
            return MHD_YES;         // Wait for more data
        }

        // Process final POST data (when upload_data_size == 0)
        const char *response_text = NULL;
        struct json_object *parsed_json = json_tokener_parse(req_data->post_data);

        if (parsed_json) {
            struct json_object *status_obj;
            if (json_object_object_get_ex(parsed_json, "status", &status_obj)) {
                const char *status = json_object_get_string(status_obj);

                if (strcmp(status, "on") == 0) {
                    startClickThread();
                    response_text = "{\"status\":\"on\"}";
                }
                else if (strcmp(status, "off") == 0) {
                    stopClickThread();
                    response_text = "{\"status\":\"off\"}";
                }
            }
            json_object_put(parsed_json);
        }

        if (!response_text) {
            response_text = "{\"error\":\"Invalid request\"}";
        }

        printf("[DEBUG] Returning status: %s\n", response_text);
        response = MHD_create_response_from_buffer(strlen(response_text),
                                                   (void*)response_text,
                                                   MHD_RESPMEM_MUST_COPY);
        MHD_add_response_header(response, "Content-Type", "application/json");
        ret = MHD_queue_response(connection, MHD_HTTP_OK, response);
        MHD_destroy_response(response);

        // Clean up request data
        free(req_data->post_data);
        free(req_data);
        *con_cls = NULL;  // Reset context

        return ret;
    }

    // Method not allowed
    const char *error_msg = "{\"error\":\"Method not allowed\"}";
    response = MHD_create_response_from_buffer(strlen(error_msg),
                                               (void*)error_msg,
                                               MHD_RESPMEM_MUST_COPY);
    MHD_add_response_header(response, "Content-Type", "application/json");
    ret = MHD_queue_response(connection, MHD_HTTP_METHOD_NOT_ALLOWED, response);
    MHD_destroy_response(response);

    printf("[DEBUG] Method not allowed: %s\n", error_msg);

    return ret;
}

static void sig_handler(int sig) {
    keep_running = 0;
    close(fdi);
    close(fdo);
}

static bool has_event_type(const unsigned int array_bit_ev[], int event_type) {
    return (array_bit_ev[event_type/32] & (1U << (event_type % 32))) != 0;
}

static bool setup_event_type(int fdi, int fdo, unsigned long event_type, int max_val, const unsigned int array_bit[]) {
    struct uinput_abs_setup abs_setup = {};
    bool abs_init_once = false;

    for (int i = 0; i < max_val; i++) {
        if (!(array_bit[i / 32] & (1U << (i % 32)))) {
            continue;
        }

        //fprintf(stderr, "Setting capability %d for event type %lu\n", i, event_type);
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

static void usage(const char *path) {
    /* take only the last portion of the path */
    const char *basename = strrchr(path, '/');
    basename = basename ? basename + 1 : path;

    fprintf(stderr, "usage: %s [OPTION]\n", basename);
    fprintf(stderr, "  -d /dev/input/by-id/…\t"
                    "Specifies which device should be captured.\n");
    fprintf(stderr, "example: %s -d /dev/input/by-id/usb-Logitech_USB_Receiver-if02-event-mouse\n", basename);
}







int main(int argc, char *argv[]) {
    printf("[DEBUG] Starting autoclicker daemon\n");

    signal(SIGTERM, sig_handler);
    struct uinput_setup usetup ={
            .id = {
                .bustype = BUS_USB,
                .vendor = 0x1111,
                .product = 0x3333 },
            .name = "Virtual Mouse" };

    int opt;
    char *device = NULL;
    while ((opt = getopt(argc, argv, "d:")) != -1) {
        switch (opt) {
            case 'd':
                device = optarg;
                break;
            case '?':
                usage(argv[0]);
                return EXIT_FAILURE;
        }
    }

    if (device == NULL) {
        usage(argv[0]);
        fprintf(stderr, "Error: Input device not specified.\n");
        fprintf(stderr, "Hint: Provide a valid input device, typically found under /dev/input/by-id/...\n");
        return EXIT_FAILURE;
    }

    //Start the fdi setup
    fdi = open(device, O_RDONLY);
    if (fdi < 0) {
        fprintf(stderr, "Error: Failed to open device [%s]: %s.\n", device, strerror(errno));
        fprintf(stderr, "Hint: Check if the device path is correct and you have the necessary permissions.\n");
        return EXIT_FAILURE;
    }

    // Read capabilities
    unsigned int
            array_bit_ev[EV_MAX/32 + 1]= {0},
            array_bit_key[KEY_MAX/32 + 1]= {0},
            array_bit_rel[REL_MAX/32 + 1]= {0},
            array_bit_abs[ABS_MAX/32 + 1]= {0},
            array_bit_msc[MSC_MAX/32 + 1]= {0};

    int ret_val = ioctl(fdi, EVIOCGBIT(0, sizeof(array_bit_ev)), &array_bit_ev);
    if (ret_val < 0) {
        fprintf(stderr, "Error: Failed to retrieve event capabilities for device [%s]: %s.\n", device, strerror(errno));
        close(fdi);
        return EXIT_FAILURE;
    }

    if (has_event_type(array_bit_ev, EV_KEY)) {
        ret_val = ioctl(fdi, EVIOCGBIT(EV_KEY, sizeof(array_bit_key)), &array_bit_key);
        if (ret_val < 0) {
            fprintf(stderr, "Error: Failed to retrieve EV_KEY capabilities for device [%s]: %s.\n", device, strerror(errno));
            close(fdi);
            return EXIT_FAILURE;
        }
    }

    if (has_event_type(array_bit_ev, EV_REL)) {
        ret_val = ioctl(fdi, EVIOCGBIT(EV_REL, sizeof(array_bit_rel)), &array_bit_rel);
        if (ret_val < 0) {
            fprintf(stderr, "Error: Failed to retrieve EV_REL capabilities for device [%s]: %s.\n", device, strerror(errno));
            close(fdi);
            return EXIT_FAILURE;
        }
    }

    if (has_event_type(array_bit_ev, EV_ABS)) {
        ret_val = ioctl(fdi, EVIOCGBIT(EV_ABS, sizeof(array_bit_abs)), &array_bit_abs);
        if (ret_val < 0) {
            fprintf(stderr, "Error: Failed to retrieve EV_ABS capabilities for device [%s]: %s.\n", device, strerror(errno));
            close(fdi);
            return EXIT_FAILURE;
        }
    }

    if (has_event_type(array_bit_ev, EV_MSC)) {
        ret_val = ioctl(fdi, EVIOCGBIT(EV_MSC, sizeof(array_bit_msc)), &array_bit_msc);
        if (ret_val < 0) {
            fprintf(stderr, "Error: Failed to retrieve EV_MSC capabilities for device [%s]: %s.\n", device, strerror(errno));
            close(fdi);
            return EXIT_FAILURE;
        }
    }

    // Start the uinput setup
    fdo = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (fdo < 0) {
        fprintf(stderr, "Error: Failed to open /dev/uinput for device [%s]: %s.\n", device, strerror(errno));
        close(fdi);
        return EXIT_FAILURE;
    }

    // Configure the virtual device
    if (ioctl(fdo, UI_DEV_SETUP, &usetup) < 0) {
        fprintf(stderr, "Error: Failed to configure the virtual device for [%s]: %s.\n", device, strerror(errno));
        close(fdo);
        close(fdi);
        return EXIT_FAILURE;
    }

    if(!setup_event_type(fdi, fdo, UI_SET_EVBIT, EV_SW, array_bit_ev)) {
        fprintf(stderr, "Cannot setup_event_type for UI_SET_EVBIT/device [%s]: %s.\n", device, strerror(errno));
        close(fdo);
        close(fdi);
        return EXIT_FAILURE;
    }

    if(!setup_event_type(fdi, fdo, UI_SET_KEYBIT, KEY_MAX, array_bit_key)) {
        fprintf(stderr, "Cannot setup_event_type for EV_KEY/device [%s]: %s.\n", device, strerror(errno));
        close(fdo);
        close(fdi);
        return EXIT_FAILURE;
    }

    if(!setup_event_type(fdi, fdo, UI_SET_RELBIT, REL_MAX, array_bit_rel)) {
        fprintf(stderr, "Cannot setup_event_type for EV_REL/device [%s]: %s.\n", device, strerror(errno));
        close(fdo);
        close(fdi);
        return EXIT_FAILURE;
    }

    if(!setup_event_type(fdi, fdo, UI_SET_ABSBIT, ABS_MAX, array_bit_abs)) {
        fprintf(stderr, "Cannot setup_event_type for EV_ABS/device [%s]: %s.\n", device, strerror(errno));
        close(fdo);
        close(fdi);
        return EXIT_FAILURE;
    }

    if(!setup_event_type(fdi, fdo, UI_SET_MSCBIT, MSC_MAX, array_bit_msc)) {
        fprintf(stderr, "Cannot setup_event_type for MSC_MAX/device [%s]: %s.\n", device, strerror(errno));
        close(fdo);
        close(fdi);
        return EXIT_FAILURE;
    }

    if (ioctl(fdo, UI_DEV_CREATE) < 0) {
        fprintf(stderr, "Cannot create device: %s.\n", strerror(errno));
        close(fdo);
        close(fdi);
        return EXIT_FAILURE;
    }

    // Wait for device to be ready
    usleep(200000);

    if (ioctl(fdi, EVIOCGRAB, 1) < 0) {
        fprintf(stderr, "Cannot grab key: %s.\n", strerror(errno));
        close(fdo);
        close(fdi);
        return EXIT_FAILURE;
    }

    // Create Unix domain socket
    int listen_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listen_fd == -1) {
        perror("socket");
        return 1;
    }

    // Setup socket address
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, SOCKET_PATH, sizeof(addr.sun_path) - 1);

    // Remove existing socket file
    unlink(SOCKET_PATH);

    // Bind socket
    if (bind(listen_fd, (struct sockaddr*)&addr, sizeof(addr)) == -1) {
        perror("bind");
        close(listen_fd);
        return 1;
    }

    // Listen
    if (listen(listen_fd, 5) == -1) {
        perror("listen");
        close(listen_fd);
        unlink(SOCKET_PATH);
        return 1;
    }

    chmod(SOCKET_PATH, 0666);

    // Start microhttpd with our Unix socket
    http_daemon = MHD_start_daemon(MHD_USE_THREAD_PER_CONNECTION,
                              0, // Port is ignored when using LISTEN_SOCKET
                              NULL,
                              NULL,
                              &handle_request,
                              NULL,
                              MHD_OPTION_LISTEN_SOCKET, listen_fd,
                              MHD_OPTION_END);

    if (http_daemon == NULL) {
        fprintf(stderr, "Failed to start daemon\n");
        close(listen_fd);
        unlink(SOCKET_PATH);
        return 1;
    }

    struct input_event ev = {0};
    while (keep_running) {
        ssize_t n = read(fdi, &ev, sizeof ev);

        //check if we read the proper size
        if (n == (ssize_t) -1) {
            if (errno == EINTR) {
                continue;
            } else {
                perror("Error reading");
                break;
            }
        } else if (n != sizeof ev) {
            fprintf(stderr, "Incomplete read.");
            break;
        }

        //printf("Regular key: %d 0x%04x (%d)\n", ev.value, (int)ev.code, (int)ev.type);
        emit(fdo, ev.type, ev.code, ev.value);
    }

    // Cleanup
    MHD_stop_daemon(http_daemon);
    unlink(SOCKET_PATH);
    perror("exit");
    return EXIT_FAILURE;
}
