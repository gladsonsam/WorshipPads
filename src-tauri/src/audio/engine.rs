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
}

/// High-level commands from the control handle to the host thread.
enum EngineCommand {
    SetOutput {
        host: String,
        device: String,
        channels: (usize, usize),
        reply: Sender<Result<(), String>>,
    },
    Play(PathBuf),
    Stop,
    SetVolume(f32),
    SetCrossfade(u32),
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
        channels: (usize, usize),
    ) -> Result<(), String> {
        let (reply, reply_rx) = crossbeam_channel::bounded(1);
        self.tx
            .send(EngineCommand::SetOutput {
                host: host.to_string(),
                device: device.to_string(),
                channels,
                reply,
            })
            .map_err(|_| "audio host thread is gone".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "audio host thread did not reply".to_string())?
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

    while let Ok(cmd) = rx.recv() {
        match cmd {
            EngineCommand::SetOutput {
                host,
                device,
                channels,
                reply,
            } => {
                let result = build_stream(&host, &device, channels, master);
                match result {
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
    channels: (usize, usize),
    master: f32,
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
    let (ch_l, ch_r) = channels;

    if ch_l >= total_channels || ch_r >= total_channels {
        return Err(format!(
            "channel pair ({ch_l},{ch_r}) out of range; device has {total_channels} channels"
        ));
    }

    // Lock-free queue: host thread → real-time callback.
    let (cmd_tx, cmd_rx) = RingBuffer::<PlayCommand>::new(64);

    let err_fn = |err| eprintln!("[audio] stream error: {err}");
    let stream = match sample_format {
        SampleFormat::F32 => {
            let cb = build_callback_f32(total_channels, ch_l, ch_r, master, cmd_rx);
            device
                .build_output_stream(&config, cb, err_fn, None)
                .map_err(|e| format!("build output stream (f32): {e}"))?
        }
        SampleFormat::I32 => {
            let cb = build_callback_i32(total_channels, ch_l, ch_r, master, cmd_rx);
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
fn drain_commands(voices: &mut Vec<Voice>, master: &mut f32, cmd_rx: &mut rtrb::Consumer<PlayCommand>) {
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
        }
    }
}

fn build_callback_f32(
    total_channels: usize,
    ch_l: usize,
    ch_r: usize,
    master_init: f32,
    mut cmd_rx: rtrb::Consumer<PlayCommand>,
) -> impl FnMut(&mut [f32], &cpal::OutputCallbackInfo) + Send + 'static {
    let mut voices: Vec<Voice> = Vec::with_capacity(4);
    let mut master = master_init;

    move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
        drain_commands(&mut voices, &mut master, &mut cmd_rx);

        for frame in data.chunks_mut(total_channels) {
            let (l, r) = mix_one_frame(&mut voices, master);
            for (i, sample) in frame.iter_mut().enumerate() {
                *sample = if i == ch_l {
                    l
                } else if i == ch_r {
                    r
                } else {
                    0.0
                };
            }
        }
    }
}

fn build_callback_i32(
    total_channels: usize,
    ch_l: usize,
    ch_r: usize,
    master_init: f32,
    mut cmd_rx: rtrb::Consumer<PlayCommand>,
) -> impl FnMut(&mut [i32], &cpal::OutputCallbackInfo) + Send + 'static {
    let mut voices: Vec<Voice> = Vec::with_capacity(4);
    let mut master = master_init;

    // i32 full-scale. Headroom of 1 sample on the negative side avoids wrap.
    const SCALE: f32 = 2_147_483_520.0;

    move |data: &mut [i32], _: &cpal::OutputCallbackInfo| {
        drain_commands(&mut voices, &mut master, &mut cmd_rx);

        for frame in data.chunks_mut(total_channels) {
            let (l, r) = mix_one_frame(&mut voices, master);
            for (i, sample) in frame.iter_mut().enumerate() {
                let v = if i == ch_l {
                    l
                } else if i == ch_r {
                    r
                } else {
                    0.0
                };
                let clipped = v.clamp(-1.0, 1.0);
                *sample = (clipped * SCALE) as i32;
            }
        }
    }
}
