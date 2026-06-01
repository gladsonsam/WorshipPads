//! Audio engine: owns the output device stream and mixes up to two looping
//! "voices" with an equal-gain crossfade, routing the stereo mix to two chosen
//! output channels of a (possibly multichannel) device.
//!
//! Threading model:
//!   - `AudioEngine` (Send + Sync) is the control handle stored in Tauri state.
//!     It sends `EngineCommand`s to a host thread.
//!   - The host thread owns the cpal `Stream` (which is `!Send`) and keeps it
//!     alive. On `SetOutput` it (re)builds the stream.
//!   - The real-time callback owns all playback state (voices, gains, master
//!     volume) and drains `PlayCommand`s from a lock-free queue each call. It
//!     never locks, allocates, or touches the filesystem.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{HostId, SampleFormat};
use crossbeam_channel::{Receiver, Sender};
use rtrb::{Consumer, RingBuffer};
use serde::Serialize;

use super::decode;

/// Info about an output device, surfaced to the UI for device/channel pickers.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    /// "WASAPI" or "ASIO" — the cpal host that owns this device.
    pub host: String,
    pub name: String,
    pub channels: usize,
    pub default_sample_rate: u32,
    /// True if this is the default output device on the default host.
    pub is_default: bool,
}

/// One looping source plus its current gain ramp.
struct Voice {
    consumer: Consumer<f32>,
    stop: Arc<AtomicBool>,
    gain: f32,
    target: f32,
    /// Per-frame gain increment magnitude.
    step: f32,
    /// Drop this voice once it has faded to silence.
    remove_when_silent: bool,
}

impl Drop for Voice {
    fn drop(&mut self) {
        // Tell the decoder thread to exit.
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Commands sent into the real-time callback via a lock-free queue.
enum PlayCommand {
    /// Fade in this new voice while fading out all existing voices.
    Crossfade(Voice),
    /// Fade everything out (Stop button), at the given per-frame gain step.
    FadeOutAll(f32),
    SetMaster(f32),
    SetClickEnabled(bool),
    SetClickBpm(f32),
    SetClickBeats(u32),
    SetClickAccent(bool),
    SetClickVolume(f32),
}

/// Initial click configuration handed to the audio callback when it's built.
/// All subsequent edits flow through `PlayCommand::SetClick*` so the RT thread
/// only ever updates itself; channel changes go through `SetOutput` instead
/// since they require rebuilding the cpal stream.
#[derive(Clone, Copy, Debug)]
pub struct ClickInit {
    pub enabled: bool,
    pub bpm: f32,
    pub beats_per_bar: u32,
    pub accent: bool,
    pub volume: f32,
}

/// High-level commands from the control handle to the host thread.
enum EngineCommand {
    SetOutput {
        host: String,
        device: String,
        pad_channels: (usize, usize),
        click_channels: (usize, usize),
        reply: Sender<Result<(), String>>,
    },
    /// Change just the click channel pair; rebuilds the stream using the last
    /// known device + pad channels + master volume + click state.
    SetClickChannels {
        channels: (usize, usize),
        reply: Sender<Result<(), String>>,
    },
    Play(PathBuf),
    Stop,
    SetVolume(f32),
    SetCrossfade(u32),
    SetClickEnabled(bool),
    SetClickBpm(f32),
    SetClickBeats(u32),
    SetClickAccent(bool),
    SetClickVolume(f32),
}

/// Control handle. Cheap to clone-share via Tauri state.
pub struct AudioEngine {
    tx: Sender<EngineCommand>,
}

impl AudioEngine {
    pub fn new() -> Self {
        let (tx, rx) = crossbeam_channel::unbounded();
        std::thread::Builder::new()
            .name("audio-host".into())
            .spawn(move || host_thread(rx))
            .expect("failed to spawn audio host thread");
        AudioEngine { tx }
    }

    /// Enumerate output devices across every cpal host available on this
    /// platform (WASAPI always; ASIO when its driver is installed and the
    /// `asio` feature was compiled in).
    pub fn list_devices() -> Vec<DeviceInfo> {
        let default_host = cpal::default_host();
        let default_device_name = default_host
            .default_output_device()
            .and_then(|d| d.name().ok());
        let default_host_id = default_host.id();

        let mut out = Vec::new();
        for host_id in cpal::available_hosts() {
            let Ok(host) = cpal::host_from_id(host_id) else {
                continue;
            };
            let host_label = host_id_label(host_id);
            let Ok(devices) = host.output_devices() else {
                continue;
            };
            for device in devices {
                let Ok(name) = device.name() else { continue };
                // Some ASIO drivers list defaults that won't actually open;
                // skip a device entirely if no output config is reachable.
                let (channels, sample_rate) = match best_output_summary(&device) {
                    Some(t) => t,
                    None => continue,
                };
                let is_default = host_id == default_host_id
                    && default_device_name.as_deref() == Some(name.as_str());
                out.push(DeviceInfo {
                    host: host_label.to_string(),
                    name,
                    channels,
                    default_sample_rate: sample_rate,
                    is_default,
                });
            }
        }
        out
    }

    pub fn set_output(
        &self,
        host: &str,
        device: &str,
        pad_channels: (usize, usize),
        click_channels: (usize, usize),
    ) -> Result<(), String> {
        let (reply, reply_rx) = crossbeam_channel::bounded(1);
        self.tx
            .send(EngineCommand::SetOutput {
                host: host.to_string(),
                device: device.to_string(),
                pad_channels,
                click_channels,
                reply,
            })
            .map_err(|_| "audio host thread is gone".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "audio host thread did not reply".to_string())?
    }

    pub fn set_click_channels(&self, channels: (usize, usize)) -> Result<(), String> {
        let (reply, reply_rx) = crossbeam_channel::bounded(1);
        self.tx
            .send(EngineCommand::SetClickChannels { channels, reply })
            .map_err(|_| "audio host thread is gone".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "audio host thread did not reply".to_string())?
    }

    pub fn set_click_enabled(&self, enabled: bool) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetClickEnabled(enabled))
            .map_err(|_| "audio host thread is gone".to_string())
    }

    pub fn set_click_bpm(&self, bpm: f32) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetClickBpm(bpm))
            .map_err(|_| "audio host thread is gone".to_string())
    }

    pub fn set_click_beats(&self, beats: u32) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetClickBeats(beats))
            .map_err(|_| "audio host thread is gone".to_string())
    }

    pub fn set_click_accent(&self, accent: bool) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetClickAccent(accent))
            .map_err(|_| "audio host thread is gone".to_string())
    }

    pub fn set_click_volume(&self, volume: f32) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetClickVolume(volume))
            .map_err(|_| "audio host thread is gone".to_string())
    }

    pub fn play(&self, path: PathBuf) -> Result<(), String> {
        self.tx
            .send(EngineCommand::Play(path))
            .map_err(|_| "audio host thread is gone".to_string())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.tx
            .send(EngineCommand::Stop)
            .map_err(|_| "audio host thread is gone".to_string())
    }

    pub fn set_volume(&self, volume: f32) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetVolume(volume.clamp(0.0, 1.0)))
            .map_err(|_| "audio host thread is gone".to_string())
    }

    /// Set the crossfade/fade-out duration (milliseconds) used for subsequent
    /// `play`/`stop` calls.
    pub fn set_crossfade(&self, ms: u32) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetCrossfade(ms))
            .map_err(|_| "audio host thread is gone".to_string())
    }
}

/// Live stream + the producer end of the callback's command queue.
struct ActiveStream {
    _stream: cpal::Stream,
    cmd_tx: rtrb::Producer<PlayCommand>,
    out_rate: u32,
}

const DEFAULT_CROSSFADE_MS: u32 = 2000;

/// Per-frame gain step so a 0→1 (or 1→0) ramp completes in `ms` at `rate`.
fn fade_step(ms: u32, rate: u32) -> f32 {
    let frames = (ms.max(1) as f32 / 1000.0 * rate as f32).max(1.0);
    1.0 / frames
}

fn host_id_label(id: HostId) -> &'static str {
    // cpal's HostId names are stable strings ("WASAPI", "ASIO", ...).
    // Centralising the conversion lets us match on them in `set_output`.
    id.name()
}

fn host_from_label(label: &str) -> Result<cpal::Host, String> {
    for id in cpal::available_hosts() {
        if host_id_label(id).eq_ignore_ascii_case(label) {
            return cpal::host_from_id(id).map_err(|e| format!("open host '{label}': {e}"));
        }
    }
    Err(format!("audio host '{label}' is not available"))
}

/// Brief (channels, sample_rate) summary for device-list rendering.
/// Prefers an f32 config (matches the default `build_output_stream` path) and
/// falls back to whatever the default config reports.
fn best_output_summary(device: &cpal::Device) -> Option<(usize, u32)> {
    if let Ok(configs) = device.supported_output_configs() {
        // Highest channel count + a reasonable default sample rate.
        let mut best: Option<(u16, u32, SampleFormat)> = None;
        for cfg in configs {
            let channels = cfg.channels();
            let sr = cfg.max_sample_rate().0.min(48_000).max(cfg.min_sample_rate().0);
            let fmt = cfg.sample_format();
            // Prefer f32 over i32 when both are available, otherwise prefer
            // higher channel count.
            let candidate = (channels, sr, fmt);
            best = Some(match best {
                None => candidate,
                Some(cur) => {
                    let cur_f32 = matches!(cur.2, SampleFormat::F32);
                    let new_f32 = matches!(fmt, SampleFormat::F32);
                    if new_f32 && !cur_f32 {
                        candidate
                    } else if !new_f32 && cur_f32 {
                        cur
                    } else if channels > cur.0 {
                        candidate
                    } else {
                        cur
                    }
                }
            });
        }
        if let Some((ch, sr, _)) = best {
            return Some((ch as usize, sr));
        }
    }
    let cfg = device.default_output_config().ok()?;
    Some((cfg.channels() as usize, cfg.sample_rate().0))
}

fn host_thread(rx: Receiver<EngineCommand>) {
    let mut active: Option<ActiveStream> = None;
    let mut master: f32 = 0.8;
    let mut crossfade_ms: u32 = DEFAULT_CROSSFADE_MS;
    // Last known device + channel layout, so SetClickChannels (and any future
    // single-knob rebuild) can re-issue build_stream with the right context.
    let mut last_host: String = String::new();
    let mut last_device: String = String::new();
    let mut last_pad_channels: (usize, usize) = (0, 1);
    // Click state shadow — re-applied on every stream rebuild. `enabled` is
    // deliberately not seeded from settings on boot (worship leaders shouldn't
    // be surprised by a live click on launch); the desktop/remote toggle it on.
    let mut click_enabled: bool = false;
    let mut click_bpm: f32 = 90.0;
    let mut click_beats: u32 = 4;
    let mut click_accent: bool = true;
    let mut click_volume: f32 = 0.8;

    while let Ok(cmd) = rx.recv() {
        match cmd {
            EngineCommand::SetOutput {
                host,
                device,
                pad_channels,
                click_channels,
                reply,
            } => {
                let click_init = ClickInit {
                    enabled: click_enabled,
                    bpm: click_bpm,
                    beats_per_bar: click_beats,
                    accent: click_accent,
                    volume: click_volume,
                };
                match build_stream(&host, &device, pad_channels, click_channels, master, click_init) {
                    Ok(stream) => {
                        last_host = host;
                        last_device = device;
                        last_pad_channels = pad_channels;
                        active = Some(stream);
                        let _ = reply.send(Ok(()));
                    }
                    Err(e) => {
                        active = None;
                        let _ = reply.send(Err(e));
                    }
                }
            }
            EngineCommand::SetClickChannels { channels, reply } => {
                if last_device.is_empty() {
                    // No active stream yet; the next SetOutput will pick up the
                    // new click channels from settings. Nothing to do here.
                    let _ = reply.send(Ok(()));
                    continue;
                }
                let click_init = ClickInit {
                    enabled: click_enabled,
                    bpm: click_bpm,
                    beats_per_bar: click_beats,
                    accent: click_accent,
                    volume: click_volume,
                };
                match build_stream(
                    &last_host,
                    &last_device,
                    last_pad_channels,
                    channels,
                    master,
                    click_init,
                ) {
                    Ok(stream) => {
                        active = Some(stream);
                        let _ = reply.send(Ok(()));
                    }
                    Err(e) => {
                        active = None;
                        let _ = reply.send(Err(e));
                    }
                }
            }
            EngineCommand::Play(path) => {
                if let Some(act) = active.as_mut() {
                    let dec = decode::spawn(path, act.out_rate);
                    let voice = Voice {
                        consumer: dec.consumer,
                        stop: dec.stop,
                        gain: 0.0,
                        target: 1.0,
                        step: fade_step(crossfade_ms, act.out_rate),
                        remove_when_silent: false,
                    };
                    let _ = act.cmd_tx.push(PlayCommand::Crossfade(voice));
                } else {
                    eprintln!("[audio] Play ignored: no output device configured");
                }
            }
            EngineCommand::Stop => {
                if let Some(act) = active.as_mut() {
                    let step = fade_step(crossfade_ms, act.out_rate);
                    let _ = act.cmd_tx.push(PlayCommand::FadeOutAll(step));
                }
            }
            EngineCommand::SetVolume(v) => {
                master = v;
                if let Some(act) = active.as_mut() {
                    let _ = act.cmd_tx.push(PlayCommand::SetMaster(v));
                }
            }
            EngineCommand::SetCrossfade(ms) => {
                crossfade_ms = ms.max(1);
            }
            EngineCommand::SetClickEnabled(en) => {
                click_enabled = en;
                if let Some(act) = active.as_mut() {
                    let _ = act.cmd_tx.push(PlayCommand::SetClickEnabled(en));
                }
            }
            EngineCommand::SetClickBpm(bpm) => {
                click_bpm = bpm;
                if let Some(act) = active.as_mut() {
                    let _ = act.cmd_tx.push(PlayCommand::SetClickBpm(bpm));
                }
            }
            EngineCommand::SetClickBeats(b) => {
                click_beats = b;
                if let Some(act) = active.as_mut() {
                    let _ = act.cmd_tx.push(PlayCommand::SetClickBeats(b));
                }
            }
            EngineCommand::SetClickAccent(a) => {
                click_accent = a;
                if let Some(act) = active.as_mut() {
                    let _ = act.cmd_tx.push(PlayCommand::SetClickAccent(a));
                }
            }
            EngineCommand::SetClickVolume(v) => {
                click_volume = v;
                if let Some(act) = active.as_mut() {
                    let _ = act.cmd_tx.push(PlayCommand::SetClickVolume(v));
                }
            }
        }
    }
}

/// Pick a usable supported config: prefer f32 (matches WASAPI default), fall
/// back to i32 (typical for ASIO drivers). Anything else is rejected.
fn pick_supported(
    device: &cpal::Device,
) -> Result<cpal::SupportedStreamConfig, String> {
    let configs: Vec<_> = device
        .supported_output_configs()
        .map_err(|e| format!("supported configs: {e}"))?
        .collect();

    // Prefer f32 at the device's max-supported sample rate, falling back to i32.
    let pick = |fmt: SampleFormat| {
        configs
            .iter()
            .find(|c| c.sample_format() == fmt)
            .cloned()
            .map(|c| c.with_max_sample_rate())
    };

    if let Some(c) = pick(SampleFormat::F32) {
        return Ok(c);
    }
    if let Some(c) = pick(SampleFormat::I32) {
        return Ok(c);
    }

    // Last resort: whatever the driver reports as default.
    let fallback = device
        .default_output_config()
        .map_err(|e| format!("default config: {e}"))?;
    if matches!(
        fallback.sample_format(),
        SampleFormat::F32 | SampleFormat::I32
    ) {
        Ok(fallback)
    } else {
        Err(format!(
            "device sample format {:?} is not supported (need f32 or i32)",
            fallback.sample_format()
        ))
    }
}

fn build_stream(
    host_label: &str,
    device_name: &str,
    pad_channels: (usize, usize),
    click_channels: (usize, usize),
    master: f32,
    click_init: ClickInit,
) -> Result<ActiveStream, String> {
    let host = host_from_label(host_label)?;
    let device = host
        .output_devices()
        .map_err(|e| format!("enumerate devices: {e}"))?
        .find(|d| d.name().map(|n| n == device_name).unwrap_or(false))
        .ok_or_else(|| format!("output device '{device_name}' not found on {host_label}"))?;

    let supported = pick_supported(&device)?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.config();
    let total_channels = config.channels as usize;
    let out_rate = config.sample_rate.0;
    let (pad_l, pad_r) = pad_channels;
    let (click_l, click_r) = click_channels;

    if pad_l >= total_channels || pad_r >= total_channels {
        return Err(format!(
            "pad channel pair ({pad_l},{pad_r}) out of range; device has {total_channels} channels"
        ));
    }
    // Click channels are allowed to be out of range — the callback simply
    // doesn't write to them. This lets us silently degrade when switching to a
    // 2-channel device without rejecting the device switch entirely.
    let click_l_opt = (click_l < total_channels).then_some(click_l);
    let click_r_opt = (click_r < total_channels).then_some(click_r);

    let click_gen = ClickGen::new(out_rate, click_init);

    // Lock-free queue: host thread → real-time callback.
    let (cmd_tx, cmd_rx) = RingBuffer::<PlayCommand>::new(64);

    let err_fn = |err| eprintln!("[audio] stream error: {err}");
    let stream = match sample_format {
        SampleFormat::F32 => {
            let cb = build_callback_f32(
                total_channels,
                pad_l,
                pad_r,
                click_l_opt,
                click_r_opt,
                master,
                click_gen,
                cmd_rx,
            );
            device
                .build_output_stream(&config, cb, err_fn, None)
                .map_err(|e| format!("build output stream (f32): {e}"))?
        }
        SampleFormat::I32 => {
            let cb = build_callback_i32(
                total_channels,
                pad_l,
                pad_r,
                click_l_opt,
                click_r_opt,
                master,
                click_gen,
                cmd_rx,
            );
            device
                .build_output_stream(&config, cb, err_fn, None)
                .map_err(|e| format!("build output stream (i32): {e}"))?
        }
        other => return Err(format!("unsupported sample format {other:?}")),
    };

    stream
        .play()
        .map_err(|e| format!("start stream: {e}"))?;

    Ok(ActiveStream {
        _stream: stream,
        cmd_tx,
        out_rate,
    })
}

/// Synthesized click. Lives entirely inside the real-time callback: no
/// allocation, no I/O, just integer counters and a windowed sine ping per beat.
/// A 20 ms equal-rate ramp on enable/disable keeps toggling click-free.
struct ClickGen {
    sample_rate: f32,
    bpm: f32,
    beats_per_bar: u32,
    accent: bool,
    volume: f32,
    samples_per_beat: f32,
    samples_since_beat: f32,
    beat_index: u32,
    // Active ping voice (one at a time — at 300 BPM the prior ping is long gone
    // before the next one fires).
    osc_phase: f32,    // radians, wraps at 2π
    osc_freq: f32,     // Hz
    osc_env: f32,      // current envelope, decays per sample
    osc_decay: f32,    // per-sample env multiplier
    // Enable ramp: ~20 ms equal-rate fade in/out to suppress click-on-toggle.
    enable_ramp: f32,
    enable_target: f32,
    enable_step: f32,
}

impl ClickGen {
    fn new(sample_rate: u32, init: ClickInit) -> Self {
        let sr = sample_rate as f32;
        let bpm = init.bpm.clamp(20.0, 400.0);
        let beats = init.beats_per_bar.clamp(1, 32);
        let enable_target = if init.enabled { 1.0 } else { 0.0 };
        ClickGen {
            sample_rate: sr,
            bpm,
            beats_per_bar: beats,
            accent: init.accent,
            volume: init.volume.clamp(0.0, 1.0),
            samples_per_beat: 60.0 / bpm * sr,
            // Re-arm so the first beat fires immediately on enable.
            samples_since_beat: 60.0 / bpm * sr,
            beat_index: 0,
            osc_phase: 0.0,
            osc_freq: 1500.0,
            osc_env: 0.0,
            osc_decay: env_decay_per_sample(sr),
            enable_ramp: enable_target,
            enable_target,
            enable_step: 1.0 / (0.020 * sr).max(1.0),
        }
    }

    fn set_bpm(&mut self, bpm: f32) {
        self.bpm = bpm.clamp(20.0, 400.0);
        self.samples_per_beat = 60.0 / self.bpm * self.sample_rate;
    }
    fn set_beats(&mut self, b: u32) {
        self.beats_per_bar = b.clamp(1, 32);
        if self.beat_index >= self.beats_per_bar {
            self.beat_index = 0;
        }
    }
    fn set_accent(&mut self, a: bool) {
        self.accent = a;
    }
    fn set_volume(&mut self, v: f32) {
        self.volume = v.clamp(0.0, 1.0);
    }
    fn set_enabled(&mut self, en: bool) {
        self.enable_target = if en { 1.0 } else { 0.0 };
        if en {
            // Re-arm beat 1 to fire immediately so the user hears the click
            // start the moment they press play.
            self.beat_index = 0;
            self.samples_since_beat = self.samples_per_beat;
            self.osc_env = 0.0;
        }
    }

    #[inline]
    fn next_sample(&mut self) -> f32 {
        if self.enable_ramp < self.enable_target {
            self.enable_ramp = (self.enable_ramp + self.enable_step).min(self.enable_target);
        } else if self.enable_ramp > self.enable_target {
            self.enable_ramp = (self.enable_ramp - self.enable_step).max(self.enable_target);
        }

        // Fully off: skip the oscillator math entirely.
        if self.enable_ramp <= 0.0 && self.enable_target <= 0.0 {
            return 0.0;
        }

        if self.samples_since_beat >= self.samples_per_beat {
            self.samples_since_beat -= self.samples_per_beat;
            let is_one = self.beat_index == 0 && self.accent;
            self.osc_freq = if is_one { 2000.0 } else { 1500.0 };
            self.osc_phase = 0.0;
            self.osc_env = if is_one { 1.0 } else { 0.7 };
            self.beat_index = (self.beat_index + 1) % self.beats_per_bar.max(1);
        }

        let s = self.osc_phase.sin() * self.osc_env * self.volume * self.enable_ramp;
        self.osc_phase += std::f32::consts::TAU * self.osc_freq / self.sample_rate;
        if self.osc_phase >= std::f32::consts::TAU {
            self.osc_phase -= std::f32::consts::TAU;
        }
        self.osc_env *= self.osc_decay;
        self.samples_since_beat += 1.0;

        s
    }
}

/// Per-sample envelope multiplier so a fresh ping decays from 1.0 to ~0.001
/// over 30 ms. Independent of BPM (the envelope IS the click).
fn env_decay_per_sample(sample_rate: f32) -> f32 {
    let frames = (sample_rate * 0.030).max(1.0);
    0.001_f32.powf(1.0 / frames)
}

/// Pull one f32 stereo frame from the active voices, mixing into (mix_l, mix_r),
/// and advance per-voice gain ramps. Shared by the f32 and i32 callbacks.
#[inline]
fn mix_one_frame(voices: &mut Vec<Voice>, master: f32) -> (f32, f32) {
    let mut mix_l = 0.0f32;
    let mut mix_r = 0.0f32;

    for v in voices.iter_mut() {
        if v.gain < v.target {
            v.gain = (v.gain + v.step).min(v.target);
        } else if v.gain > v.target {
            v.gain = (v.gain - v.step).max(v.target);
        }

        if v.consumer.slots() >= 2 {
            let l = v.consumer.pop().unwrap_or(0.0);
            let r = v.consumer.pop().unwrap_or(0.0);
            mix_l += l * v.gain;
            mix_r += r * v.gain;
        }
    }

    voices.retain(|v| !(v.remove_when_silent && v.gain <= 0.0));

    (mix_l * master, mix_r * master)
}

#[inline]
fn drain_commands(
    voices: &mut Vec<Voice>,
    master: &mut f32,
    click: &mut ClickGen,
    cmd_rx: &mut rtrb::Consumer<PlayCommand>,
) {
    while let Ok(cmd) = cmd_rx.pop() {
        match cmd {
            PlayCommand::Crossfade(v) => {
                for old in voices.iter_mut() {
                    old.target = 0.0;
                    old.remove_when_silent = true;
                }
                voices.push(v);
            }
            PlayCommand::FadeOutAll(step) => {
                for v in voices.iter_mut() {
                    v.target = 0.0;
                    v.step = step;
                    v.remove_when_silent = true;
                }
            }
            PlayCommand::SetMaster(m) => *master = m,
            PlayCommand::SetClickEnabled(en) => click.set_enabled(en),
            PlayCommand::SetClickBpm(bpm) => click.set_bpm(bpm),
            PlayCommand::SetClickBeats(b) => click.set_beats(b),
            PlayCommand::SetClickAccent(a) => click.set_accent(a),
            PlayCommand::SetClickVolume(v) => click.set_volume(v),
        }
    }
}

/// Write `(pad_l, pad_r, click)` into the right slots of `frame`. Collisions
/// (click channel == pad channel) sum naturally.
#[inline]
fn write_frame_f32(
    frame: &mut [f32],
    pad_l_idx: usize,
    pad_r_idx: usize,
    click_l_idx: Option<usize>,
    click_r_idx: Option<usize>,
    pad_l: f32,
    pad_r: f32,
    click: f32,
) {
    for sample in frame.iter_mut() {
        *sample = 0.0;
    }
    if pad_l_idx < frame.len() {
        frame[pad_l_idx] += pad_l;
    }
    if pad_r_idx < frame.len() {
        frame[pad_r_idx] += pad_r;
    }
    if let Some(i) = click_l_idx {
        if i < frame.len() {
            frame[i] += click;
        }
    }
    if let Some(i) = click_r_idx {
        if i < frame.len() {
            frame[i] += click;
        }
    }
}

fn build_callback_f32(
    total_channels: usize,
    pad_l: usize,
    pad_r: usize,
    click_l: Option<usize>,
    click_r: Option<usize>,
    master_init: f32,
    click_init: ClickGen,
    mut cmd_rx: rtrb::Consumer<PlayCommand>,
) -> impl FnMut(&mut [f32], &cpal::OutputCallbackInfo) + Send + 'static {
    let mut voices: Vec<Voice> = Vec::with_capacity(4);
    let mut master = master_init;
    let mut click = click_init;

    move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
        drain_commands(&mut voices, &mut master, &mut click, &mut cmd_rx);

        for frame in data.chunks_mut(total_channels) {
            let (l, r) = mix_one_frame(&mut voices, master);
            let c = click.next_sample();
            write_frame_f32(frame, pad_l, pad_r, click_l, click_r, l, r, c);
        }
    }
}

fn build_callback_i32(
    total_channels: usize,
    pad_l: usize,
    pad_r: usize,
    click_l: Option<usize>,
    click_r: Option<usize>,
    master_init: f32,
    click_init: ClickGen,
    mut cmd_rx: rtrb::Consumer<PlayCommand>,
) -> impl FnMut(&mut [i32], &cpal::OutputCallbackInfo) + Send + 'static {
    let mut voices: Vec<Voice> = Vec::with_capacity(4);
    let mut master = master_init;
    let mut click = click_init;

    // i32 full-scale. Headroom of 1 sample on the negative side avoids wrap.
    const SCALE: f32 = 2_147_483_520.0;

    // Scratch buffer reused per frame so we can compose the f32 sum and then
    // convert; sized for the worst-case channel count we'll ever see.
    let mut scratch = [0.0f32; 64];

    move |data: &mut [i32], _: &cpal::OutputCallbackInfo| {
        drain_commands(&mut voices, &mut master, &mut click, &mut cmd_rx);

        for frame in data.chunks_mut(total_channels) {
            let (l, r) = mix_one_frame(&mut voices, master);
            let c = click.next_sample();

            let n = frame.len().min(scratch.len());
            let scratch = &mut scratch[..n];
            write_frame_f32(scratch, pad_l, pad_r, click_l, click_r, l, r, c);

            for (out, v) in frame.iter_mut().zip(scratch.iter()) {
                let clipped = v.clamp(-1.0, 1.0);
                *out = (clipped * SCALE) as i32;
            }
        }
    }
}
