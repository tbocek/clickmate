#pkg-config from: https://www.geany.org/manual/gtk/glib/glib-compiling.html
#https://github.com/joprietoe/gdbus/blob/master/Makefile
#https://stackoverflow.com/questions/51269129/minimal-gdbus-client
TARGET = macroclickwerk
CC = gcc
CFLAGS = -Wall -O3 -lpthread -ljson-c -lmicrohttpd

.PHONY: default all clean install uninstall watch

default: all

all: macroclickwerk.c
	$(CC) $(CFLAGS) -o $(TARGET) macroclickwerk.c

watch:
	./tools/watch-events 15

clean:
	-rm -f *.o
	-rm -f $(TARGET)

install:
	cp macroclickwerk /usr/local/bin/
	cp macroclickwerk.service /etc/systemd/system/
	install -m 755 macroclickwerk-sleep /usr/lib/systemd/system-sleep/macroclickwerk
	systemctl restart systemd-udevd.service
	systemctl daemon-reload
	systemctl enable macroclickwerk
	systemctl start macroclickwerk

uninstall:
	systemctl stop macroclickwerk
	systemctl disable macroclickwerk
	rm /usr/local/bin/macroclickwerk
	rm /etc/systemd/system/macroclickwerk.service
	rm -f /usr/lib/systemd/system-sleep/macroclickwerk
	systemctl restart systemd-udevd.service
	systemctl daemon-reload
