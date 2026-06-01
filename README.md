<p align="center">
  <img src="public/logo.svg" alt="StagePal" width="112" height="112" />
</p>

<h1 align="center">StagePal</h1>

A Tauri desktop app that plays looping worship pads locally and
routes them to specific channels of any audio interface (via ASIO),
while your phone acts as a wireless remote.

<p align="center">
  <img src="public/screenshots/app1.png" alt="StagePal desktop app" width="500" />
  &nbsp;
  <img src="public/screenshots/remote1.png" alt="Phone remote" height="367" />
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

Requires Node and a Rust toolchain set up for [Tauri 2](https://tauri.app/start/prerequisites/).
The default build links ASIO via `cpal`, so it also needs the Steinberg ASIO SDK
and `libclang` on `PATH`; pass `--no-default-features` to skip ASIO.

```bash
npm install
npm run tauri dev
```
