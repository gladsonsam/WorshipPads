<p align="center">
  <img src="public/logo.svg" alt="Worship Pads" width="112" height="112" />
</p>

<h1 align="center">Worship Pads</h1>

A Tauri desktop app that plays looping worship pads locally and
routes them to specific channels of any audio interface (via ASIO on Windows),
while your phone acts as a wireless remote.

<p align="center">
  <img src="public/screenshots/app.png" alt="Worship Pads desktop app" width="640" />
  &nbsp;
  <img src="public/screenshots/remote.png" alt="Phone remote" width="200" />
</p>

## Features

- **Pad library** - point it at a folder of audio files; keys are matched
  from the file names, with a resolver for anything that doesn't auto-match.
- **Grid or piano** pad layout, on both the desktop app and the phone remote.
- **Crossfade** between pads and on stop/fade-out.
- **Channel routing** - map the stereo pair to specific hardware output
  channels so pads land on the return you want.
- **Phone remote** - scan a QR code to open a one-handed remote on any phone on
  the same network.

## Development

```bash
npm install
npm run tauri dev      # launches the app (starts hidden in the tray)
```
