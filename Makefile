#pkg-config from: https://www.geany.org/manual/gtk/glib/glib-compiling.html
#https://github.com/joprietoe/gdbus/blob/master/Makefile
#https://stackoverflow.com/questions/51269129/minimal-gdbus-client
TARGET = clickmate
CC = gcc
CFLAGS = -Wall -O3 -lpthread -ljson-c -lmicrohttpd

.PHONY: default all clean install uninstall watch

default: all

all: clickmate.c
	$(CC) $(CFLAGS) -o $(TARGET) clickmate.c

watch:
	./tools/watch-events 15

clean:
	-rm -f *.o
	-rm -f $(TARGET)

install:
	cp clickmate /usr/local/bin/
	cp clickmate.service /etc/systemd/system/
	install -m 755 clickmate-sleep /usr/lib/systemd/system-sleep/clickmate
	systemctl restart systemd-udevd.service
	systemctl daemon-reload
	systemctl enable clickmate
	systemctl start clickmate

uninstall:
	systemctl stop clickmate
	systemctl disable clickmate
	rm /usr/local/bin/clickmate
	rm /etc/systemd/system/clickmate.service
	rm -f /usr/lib/systemd/system-sleep/clickmate
	systemctl restart systemd-udevd.service
	systemctl daemon-reload
