# LRT Televizija for webOS

A packaged webOS app that plays the free LRT Televizija live stream on an LG TV. On launch the app asks LRT for a fresh HLS address and plays it with the TV’s native player.

The stream address is signed for the IP that requested it, so the TV must request it itself. An address fetched on a computer will not play on the TV.

This is a personal sideload. It is not published in the LG Content Store.

## What you need

- An LG webOS TV and a computer on the same network
- [Node.js](https://nodejs.org/)
- The LG Developer Mode app, installed on the TV from the Content Store

## Turn on Developer Mode

1. On the TV, open the Developer Mode app and sign in with an LG account.
2. Turn **Dev Mode Status** on. The TV may reboot.
3. Turn **Key Server** on.
4. Note the TV’s IP address and the passphrase shown in the app.

The Developer Mode session has a time limit (about 50 hours on many firmware versions). The app shows the time left. Extend the session there before it runs out, or the TV leaves developer mode and the sideloaded app stops launching.

## Install the command-line tools

```bash
npm install -g @webos-tools/cli
```

## Register the TV

Replace the IP with the address shown in Developer Mode. The username for a TV is `prisoner`, and the port is `9922`.

```bash
ares-setup-device --add tv --info "{'host':'192.168.0.10','port':'9922','username':'prisoner'}"
ares-novacom --device tv --getkey
```

`ares-novacom --getkey` asks for the passphrase from the Developer Mode app.

## Package, install, and launch

From this directory:

```bash
ares-package .
ares-install --device tv ./lt.personal.lrttelevizija_1.0.0_all.ipk
ares-launch --device tv lt.personal.lrttelevizija
```

Installing the same app id again replaces the previous package. The webOS emulator is a poor test for this app: HLS playback needs the TV.

## Remote

- **Back** leaves the app. On webOS TV 6.0 and later the TV asks you to confirm. On older TVs it returns to Home.
- **Play** and **Pause** start and pause the picture. **Play/Pause** toggles it.
- If the stream cannot be started, the screen says **Nepavyko paleisti**. Press **OK** to try again.

## Third-party code

`webOSTV.js` is LG’s webOS TV library (1.2.11), used for `webOS.platformBack()`. It is covered by the Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0
