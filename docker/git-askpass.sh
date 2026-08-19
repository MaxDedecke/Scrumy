#!/bin/sh
# Git ruft dieses Programm fuer HTTPS-Credentials auf. Der Token kommt nur aus
# der Prozessumgebung, niemals aus Argumenten oder einer gespeicherten URL.
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *) printf '%s\n' "$SCRUMY_GIT_TOKEN" ;;
esac
