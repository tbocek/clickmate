#pkg-config from: https://www.geany.org/manual/gtk/glib/glib-compiling.html
#https://github.com/joprietoe/gdbus/blob/master/Makefile
#https://stackoverflow.com/questions/51269129/minimal-gdbus-client
TARGET = clickmate
CC = gcc
CFLAGS = -Wall -O3

.PHONY: default all clean install uninstall

default: all

all: clickmate.c
	$(CC) $(CFLAGS) -o $(TARGET) dvorak.c

clean:
	-rm -f *.o
	-rm -f $(TARGET)

install:
	cp clickmate /usr/local/bin/
	cp 80-clickmate.rules /etc/udev/rules.d/
	cp clickmate@.service /etc/systemd/system/
	udevadm control --reload
	systemctl restart systemd-udevd.service
	systemctl daemon-reload

uninstall:
	systemctl stop 'clickmate@*.service'
	rm /usr/local/bin/clickmate
	rm /etc/udev/rules.d/80-clickmate.rules
	rm /etc/systemd/system/clickmate@.service
	udevadm control --reload
	systemctl restart systemd-udevd.service
	systemctl daemon-reload
