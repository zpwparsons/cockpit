#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."

bun tauri build --bundles app,dmg

dmg=(src-tauri/target/release/bundle/dmg/*.dmg)
dmg=$dmg[1]
rw=$(mktemp -d)/rw.dmg
hdiutil convert "$dmg" -format UDRW -o "$rw" -quiet
mnt=$(hdiutil attach "$rw" -noautoopen | awk -F'\t' '/Volumes/ {print $NF}')
name=${mnt:t}

osascript <<OSA
tell application "Finder"
  tell disk "$name"
    open
    set position of item ".VolumeIcon.icns" of container window to {2000, 2000}
    update without registering applications
    delay 1
    close
  end tell
end tell
OSA

SetFile -a C "$mnt"
rm -rf "$mnt/.fseventsd" "$mnt/.Trashes"
sync
hdiutil detach "$mnt" -quiet
rm "$dmg"
hdiutil convert "$rw" -format UDZO -imagekey zlib-level=9 -o "$dmg" -quiet
rm -rf "${rw:h}"
echo "$dmg"
