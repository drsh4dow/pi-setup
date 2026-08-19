#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 6 ]; then
	printf 'usage: log.sh <logfile> <phase> <decision> <why> <evidence> <result>\n' >&2
	exit 1
fi

logfile="$1"
shift
mkdir -p "$(dirname "$logfile")"

if [ ! -e "$logfile" ]; then
	printf 'ts\tphase\tdecision\twhy\tevidence\tresult\n' > "$logfile"
elif [ ! -f "$logfile" ]; then
	printf 'log path is not a regular file: %s\n' "$logfile" >&2
	exit 1
fi

clean() {
	local value
	value=$(printf '%s' "$1" | tr '\t\n\r' '   ')
	case "$value" in
		[=+@-]*) printf "'%s" "$value" ;;
		*) printf '%s' "$value" ;;
	esac
}

printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
	"$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	"$(clean "$1")" "$(clean "$2")" "$(clean "$3")" "$(clean "$4")" "$(clean "$5")" \
	>> "$logfile"
