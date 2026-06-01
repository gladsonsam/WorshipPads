//! Streaming decoder: reads a pad file, resamples it to the device sample rate,
//! loops it seamlessly, and pushes interleaved-stereo f32 samples into a
//! lock-free ring buffer that the audio callback drains.
//!
//! All the heavy lifting (file IO, MP3/AAC/FLAC decode, sample-rate conversion)
//! happens here on a dedicated thread — never inside the real-time audio
//! callback. A multi-minute pad is streamed, not decoded into memory up front.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rtrb::{Consumer, Producer, RingBuffer};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Input frames fed to the resampler per call.
const CHUNK: usize = 1024;

/// Handle to a running decoder thread. The audio callback owns the `consumer`;
/// dropping the owning `Voice` flips `stop`, which makes the decoder thread exit.
/// `ended` is set true the moment the decoder thread is no longer producing
/// samples (either reached EOF on a non-looping source or was asked to stop) —
/// used by the host thread to fire a "cue ended" event without polling audio
/// callback state.
pub struct Decoder {
    pub consumer: Consumer<f32>,
    pub stop: Arc<AtomicBool>,
    pub ended: Arc<AtomicBool>,
}

/// Spawn a decoder thread for `path`, producing interleaved-stereo f32 at `out_rate`.
/// When `loop_when_eof` is true (pads), the decoder reopens the source on EOF
/// for seamless looping. When false (one-shot cues / spoken WAVs), the decoder
/// exits cleanly at EOF and flips `ended`. If `delete_on_exit` is true, `path`
/// is removed after the decoder finishes — used for synthesized cue WAVs we
/// own in %TEMP%.
pub fn spawn(path: PathBuf, out_rate: u32, loop_when_eof: bool, delete_on_exit: bool) -> Decoder {
    // ~2 seconds of stereo headroom in the ring buffer.
    let capacity = (out_rate as usize * 2 * 2).max(16384);
    let (producer, consumer) = RingBuffer::<f32>::new(capacity);
    let stop = Arc::new(AtomicBool::new(false));
    let ended = Arc::new(AtomicBool::new(false));

    let stop_thread = stop.clone();
    let ended_thread = ended.clone();
    std::thread::Builder::new()
        .name("pad-decoder".into())
        .spawn(move || {
            if let Err(e) = decode_loop(&path, out_rate, producer, &stop_thread, loop_when_eof) {
                eprintln!("[audio] decoder for {path:?} stopped: {e}");
            }
            if delete_on_exit {
                if let Err(e) = std::fs::remove_file(&path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        eprintln!("[audio] could not delete cue file {path:?}: {e}");
                    }
                }
            }
            ended_thread.store(true, Ordering::Relaxed);
        })
        .expect("failed to spawn decoder thread");

    Decoder { consumer, stop, ended }
}

struct Source {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    in_rate: u32,
    in_channels: usize,
}

fn open(path: &Path) -> Result<Source, String> {
    let file = File::open(path).map_err(|e| format!("open {path:?}: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe: {e}"))?;

    let format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("no playable audio track")?;
    let track_id = track.id;
    let in_rate = track
        .codec_params
        .sample_rate
        .ok_or("file has unknown sample rate")?;
    let in_channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(2)
        .max(1);

    let decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("make decoder: {e}"))?;

    Ok(Source {
        format,
        decoder,
        track_id,
        in_rate,
        in_channels,
    })
}

fn make_resampler(in_rate: u32, out_rate: u32) -> Result<SincFixedIn<f32>, String> {
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    SincFixedIn::<f32>::new(
        out_rate as f64 / in_rate as f64,
        2.0,
        params,
        CHUNK,
        2, // we always feed stereo
    )
    .map_err(|e| format!("resampler init: {e}"))
}

fn decode_loop(
    path: &Path,
    out_rate: u32,
    mut producer: Producer<f32>,
    stop: &AtomicBool,
    loop_when_eof: bool,
) -> Result<(), String> {
    let mut src = open(path)?;
    let resample = src.in_rate != out_rate;
    let mut resampler = if resample {
        Some(make_resampler(src.in_rate, out_rate)?)
    } else {
        None
    };

    // Pending decoded stereo, deinterleaved into two planar channel buffers.
    let mut pend_l: Vec<f32> = Vec::with_capacity(CHUNK * 4);
    let mut pend_r: Vec<f32> = Vec::with_capacity(CHUNK * 4);
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        if stop.load(Ordering::Relaxed) || producer.is_abandoned() {
            return Ok(());
        }

        let packet = match src.format.next_packet() {
            Ok(p) => p,
            Err(_) => {
                // End of file → flush remaining whole chunks. Pads reopen the
                // source for seamless looping; cues / spoken WAVs exit so the
                // host thread can notice the decoder is done.
                flush_chunks(&mut pend_l, &mut pend_r, resampler.as_mut(), &mut producer, stop)?;
                if !loop_when_eof {
                    return Ok(());
                }
                src = open(path)?;
                continue;
            }
        };
        if packet.track_id() != src.track_id {
            continue;
        }

        let decoded = match src.decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue, // skip a bad frame
            Err(e) => return Err(format!("decode: {e}")),
        };

        let spec = *decoded.spec();
        let frames = decoded.capacity();
        let buf = sample_buf.get_or_insert_with(|| SampleBuffer::<f32>::new(frames as u64, spec));
        buf.copy_interleaved_ref(decoded);

        for frame in buf.samples().chunks(src.in_channels) {
            let l = frame[0];
            let r = if src.in_channels > 1 { frame[1] } else { l };
            pend_l.push(l);
            pend_r.push(r);
        }

        while pend_l.len() >= CHUNK {
            push_chunk(&mut pend_l, &mut pend_r, resampler.as_mut(), &mut producer, stop)?;
            if stop.load(Ordering::Relaxed) || producer.is_abandoned() {
                return Ok(());
            }
        }
    }
}

/// Take exactly CHUNK frames off the pending buffers, resample if needed,
/// interleave, and push to the ring.
fn push_chunk(
    pend_l: &mut Vec<f32>,
    pend_r: &mut Vec<f32>,
    resampler: Option<&mut SincFixedIn<f32>>,
    producer: &mut Producer<f32>,
    stop: &AtomicBool,
) -> Result<(), String> {
    let left: Vec<f32> = pend_l.drain(..CHUNK).collect();
    let right: Vec<f32> = pend_r.drain(..CHUNK).collect();

    match resampler {
        Some(rs) => {
            let out = rs
                .process(&[left, right], None)
                .map_err(|e| format!("resample: {e}"))?;
            push_interleaved(&out[0], &out[1], producer, stop);
        }
        None => push_interleaved(&left, &right, producer, stop),
    }
    Ok(())
}

/// At EOF, drop any partial remainder (< CHUNK) so the next loop starts clean.
fn flush_chunks(
    pend_l: &mut Vec<f32>,
    pend_r: &mut Vec<f32>,
    mut resampler: Option<&mut SincFixedIn<f32>>,
    producer: &mut Producer<f32>,
    stop: &AtomicBool,
) -> Result<(), String> {
    while pend_l.len() >= CHUNK {
        push_chunk(pend_l, pend_r, resampler.as_deref_mut(), producer, stop)?;
    }
    pend_l.clear();
    pend_r.clear();
    Ok(())
}

fn push_interleaved(left: &[f32], right: &[f32], producer: &mut Producer<f32>, stop: &AtomicBool) {
    for i in 0..left.len() {
        for s in [left[i], right[i]] {
            // Spin until the ring has room; bail out if we're being torn down.
            loop {
                if producer.push(s).is_ok() {
                    break;
                }
                if stop.load(Ordering::Relaxed) || producer.is_abandoned() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
}
