//! Native PulseAudio playback engine.
//!
//! WebKitGTK's audio path (WebAudio → GStreamer → pulsesink) underruns audibly
//! on bridged audio stacks like WSLg whenever the CPU spikes, and its buffer
//! size isn't controllable from the app. So on Linux we play the decoded PCM
//! ourselves: `libpulse-simple.so.0` is dlopen'd at runtime (no build-time or
//! packaging dependency), a mixer thread streams 20 ms chunks into a 200 ms
//! stream buffer, and hit-ticks are mixed in sample-accurately. When the
//! library isn't there (Windows, macOS, unusual Linuxes) `native_available`
//! returns false and the frontend keeps using its WebAudio player.

use std::ffi::{c_char, c_int, c_void};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;

// ---------------------------------------------------------------------------
// pa_simple via dlopen
// ---------------------------------------------------------------------------

#[repr(C)]
struct SampleSpec {
    format: c_int, // 3 = PA_SAMPLE_S16LE
    rate: u32,
    channels: u8,
}

#[repr(C)]
struct BufferAttr {
    maxlength: u32,
    tlength: u32,
    prebuf: u32,
    minreq: u32,
    fragsize: u32,
}

const PA_STREAM_PLAYBACK: c_int = 1;
const PA_SAMPLE_S16LE: c_int = 3;

type NewFn = unsafe extern "C" fn(
    *const c_char, // server (null = default, honors PULSE_SERVER)
    *const c_char, // client name
    c_int,         // direction
    *const c_char, // device (null = default)
    *const c_char, // stream name
    *const SampleSpec,
    *const c_void, // channel map
    *const BufferAttr,
    *mut c_int, // error
) -> *mut c_void;
type WriteFn = unsafe extern "C" fn(*mut c_void, *const c_void, usize, *mut c_int) -> c_int;
type FlushFn = unsafe extern "C" fn(*mut c_void, *mut c_int) -> c_int;
type LatencyFn = unsafe extern "C" fn(*mut c_void, *mut c_int) -> u64;
type FreeFn = unsafe extern "C" fn(*mut c_void);

struct PaApi {
    _lib: libloading::Library,
    new_: NewFn,
    write: WriteFn,
    flush: FlushFn,
    get_latency: LatencyFn,
    free: FreeFn,
}

// pa_simple handles are used from exactly one thread at a time (the mixer
// thread that created them), which is pa_simple's threading contract.
unsafe impl Send for PaApi {}
unsafe impl Sync for PaApi {}

static PA: OnceLock<Option<PaApi>> = OnceLock::new();

fn pa() -> Option<&'static PaApi> {
    PA.get_or_init(load_pa).as_ref()
}

#[cfg(target_os = "linux")]
fn load_pa() -> Option<PaApi> {
    unsafe {
        for name in ["libpulse-simple.so.0", "libpulse-simple.so"] {
            let Ok(lib) = libloading::Library::new(name) else {
                continue;
            };
            let new_: NewFn = match lib.get(b"pa_simple_new\0") {
                Ok(s) => *s,
                Err(_) => continue,
            };
            let write: WriteFn = match lib.get(b"pa_simple_write\0") {
                Ok(s) => *s,
                Err(_) => continue,
            };
            let flush: FlushFn = match lib.get(b"pa_simple_flush\0") {
                Ok(s) => *s,
                Err(_) => continue,
            };
            let get_latency: LatencyFn = match lib.get(b"pa_simple_get_latency\0") {
                Ok(s) => *s,
                Err(_) => continue,
            };
            let free: FreeFn = match lib.get(b"pa_simple_free\0") {
                Ok(s) => *s,
                Err(_) => continue,
            };
            return Some(PaApi {
                new_,
                write,
                flush,
                get_latency,
                free,
                _lib: lib,
            });
        }
        None
    }
}

#[cfg(not(target_os = "linux"))]
fn load_pa() -> Option<PaApi> {
    None
}

// ---------------------------------------------------------------------------
// player state
// ---------------------------------------------------------------------------

pub struct Pcm {
    pub rate: u32,
    pub channels: u32,
    pub data: Vec<i16>,
}

pub struct Shared {
    pcm: Option<Arc<Pcm>>,
    /// Write cursor in source frames (fractional — advanced by rate_mult).
    pos: f64,
    playing: bool,
    rate_mult: f64,
    /// Music gain, 0-1. Ticks have their own fixed TICK_GAIN and aren't affected.
    volume: f64,
    ticks: Vec<f64>, // note times in seconds, sorted
    ticks_enabled: bool,
    ticks_dirty: bool,
    latency_sec: f64,
}

pub struct NativeAudio {
    inner: Arc<Mutex<Shared>>,
    generation: Arc<AtomicU64>,
}

impl NativeAudio {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Shared {
                pcm: None,
                pos: 0.0,
                playing: false,
                rate_mult: 1.0,
                volume: 1.0,
                ticks: Vec::new(),
                ticks_enabled: true,
                ticks_dirty: false,
                latency_sec: 0.0,
            })),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Install newly decoded audio (called by project_load_audio) and stop playback.
    pub fn set_pcm(&self, rate: u32, channels: u32, data: Vec<i16>) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let mut s = self.inner.lock().unwrap();
        s.pcm = Some(Arc::new(Pcm {
            rate,
            channels,
            data,
        }));
        s.pos = 0.0;
        s.playing = false;
        s.latency_sec = 0.0;
    }
}

// ---------------------------------------------------------------------------
// mixer thread
// ---------------------------------------------------------------------------

const BUFFER_SEC: f64 = 0.20; // pulse stream buffer — the anti-underrun cushion
const CHUNK_SEC: f64 = 0.02;
const TICK_FREQ: f64 = 1660.0;
const TICK_DECAY: f64 = 0.012;
const TICK_LEN: f64 = 0.06;
const TICK_GAIN: f32 = 0.28;

fn lower_bound(arr: &[f64], v: f64) -> usize {
    arr.partition_point(|x| *x < v)
}

fn mixer(inner: Arc<Mutex<Shared>>, generation: Arc<AtomicU64>, my_gen: u64) {
    let Some(api) = pa() else {
        inner.lock().unwrap().playing = false;
        return;
    };

    let (pcm, mut pos, mut tick_idx) = {
        let mut s = inner.lock().unwrap();
        let Some(pcm) = s.pcm.clone() else {
            s.playing = false;
            return;
        };
        s.ticks_dirty = false;
        let sec = s.pos / pcm.rate as f64;
        let idx = lower_bound(&s.ticks, sec + 1e-6);
        (pcm, s.pos, idx)
    };
    let mut rate_mult;
    let mut ticks_enabled;
    let mut volume;

    let channels = pcm.channels.max(1) as usize;
    let frames_total = (pcm.data.len() / channels) as f64;
    let bytes_per_frame = 2 * channels as u32;
    let spec = SampleSpec {
        format: PA_SAMPLE_S16LE,
        rate: pcm.rate,
        channels: channels as u8,
    };
    let attr = BufferAttr {
        maxlength: u32::MAX,
        tlength: (BUFFER_SEC * pcm.rate as f64) as u32 * bytes_per_frame,
        prebuf: u32::MAX,
        minreq: u32::MAX,
        fragsize: u32::MAX,
    };
    let mut err: c_int = 0;
    let stream = unsafe {
        (api.new_)(
            std::ptr::null(),
            c"Charter".as_ptr(),
            PA_STREAM_PLAYBACK,
            std::ptr::null(),
            c"chart playback".as_ptr(),
            &spec,
            std::ptr::null(),
            &attr,
            &mut err,
        )
    };
    if stream.is_null() {
        inner.lock().unwrap().playing = false;
        return;
    }

    let chunk_frames = ((pcm.rate as f64 * CHUNK_SEC) as usize).max(64);
    let mut buf: Vec<i16> = vec![0; chunk_frames * channels];
    let mut tick_ages: Vec<f64> = Vec::new(); // in output frames
    let mut latency_sec = 0.0f64;
    let mut ended = false;
    let mut aborted = false;

    'outer: loop {
        // sync with control state
        {
            let mut s = inner.lock().unwrap();
            if generation.load(Ordering::SeqCst) != my_gen {
                aborted = true;
                break;
            }
            s.pos = pos;
            s.latency_sec = latency_sec;
            rate_mult = s.rate_mult;
            ticks_enabled = s.ticks_enabled;
            volume = s.volume;
            if s.ticks_dirty {
                s.ticks_dirty = false;
                tick_idx = lower_bound(&s.ticks, pos / pcm.rate as f64 + 1e-6);
            }
            if ended {
                s.playing = false;
                s.pos = frames_total;
                // nothing left to rewind by: leaving the last buffered
                // latency here parks position/pause ~0.2s before the end
                s.latency_sec = 0.0;
                break;
            }
            // render ticks against the (possibly updated) list
            for k in 0..chunk_frames {
                let base = k * channels;
                let sec = pos / pcm.rate as f64;
                while tick_idx < s.ticks.len() && s.ticks[tick_idx] <= sec {
                    if ticks_enabled {
                        tick_ages.push(0.0);
                    }
                    tick_idx += 1;
                }
                let mut tick = 0.0f32;
                for age in &mut tick_ages {
                    let t = *age / pcm.rate as f64;
                    tick += ((2.0 * std::f64::consts::PI * TICK_FREQ * t).sin()
                        * (-t / TICK_DECAY).exp()) as f32;
                    *age += 1.0;
                }
                tick_ages.retain(|a| *a / pcm.rate as f64 <= TICK_LEN);
                let tick_add = tick * TICK_GAIN * 32767.0;

                if pos + 1.0 >= frames_total {
                    ended = true;
                    for c in 0..channels {
                        buf[base + c] = 0;
                    }
                } else {
                    let i = pos as usize;
                    let frac = (pos - i as f64) as f32;
                    for c in 0..channels {
                        let a = pcm.data[i * channels + c] as f32;
                        let b = pcm.data[(i + 1) * channels + c] as f32;
                        let v = (a + (b - a) * frac) * volume as f32 + tick_add;
                        buf[base + c] = v.clamp(-32768.0, 32767.0) as i16;
                    }
                }
                if !ended {
                    pos += rate_mult;
                }
            }
        }

        // blocking write paces the loop; do it without holding the lock
        let rc = unsafe {
            (api.write)(
                stream,
                buf.as_ptr() as *const c_void,
                buf.len() * 2,
                &mut err,
            )
        };
        if rc < 0 {
            let mut s = inner.lock().unwrap();
            if generation.load(Ordering::SeqCst) == my_gen {
                s.playing = false;
            }
            aborted = true;
            break 'outer;
        }
        // (pa_usec_t)-1 on failure; storing that as ~1.8e13 s would pin the
        // display position at 0 and make the next pause rewind to the start,
        // so keep the previous estimate instead
        let lat = unsafe { (api.get_latency)(stream, &mut err) };
        if lat != u64::MAX {
            latency_sec = lat as f64 / 1_000_000.0;
        }
    }

    unsafe {
        if aborted {
            // seek/pause/new-audio: drop what hasn't played yet
            (api.flush)(stream, &mut err);
        } else {
            // natural end: let the buffered tail play out
            std::thread::sleep(std::time::Duration::from_secs_f64(latency_sec.min(1.0)));
        }
        (api.free)(stream);
    }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn native_available() -> bool {
    pa().is_some()
}

pub fn start_playback(state: &NativeAudio, from_sec: f64, rate: f64) -> Result<(), String> {
    if pa().is_none() {
        return Err("Native audio not available".into());
    }
    let my_gen;
    {
        // bump the generation INSIDE the state lock: a concurrent pause could
        // otherwise interleave between the bump and playing=true, leaving the
        // state wedged at playing with no mixer thread
        let mut s = state.inner.lock().unwrap();
        my_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let Some(pcm) = s.pcm.as_ref() else {
            return Err("No audio loaded".into());
        };
        s.pos = (from_sec.max(0.0) * pcm.rate as f64)
            .min((pcm.data.len() / pcm.channels.max(1) as usize) as f64);
        s.rate_mult = rate.clamp(0.1, 4.0);
        s.playing = true;
        s.latency_sec = 0.0;
    }
    let inner = state.inner.clone();
    let generation = state.generation.clone();
    std::thread::spawn(move || mixer(inner, generation, my_gen));
    Ok(())
}

pub fn pause_playback(state: &NativeAudio) -> f64 {
    let mut s = state.inner.lock().unwrap();
    state.generation.fetch_add(1, Ordering::SeqCst);
    let rate = s.pcm.as_ref().map(|p| p.rate as f64).unwrap_or(44100.0);
    // rewind by what was buffered but never heard
    let heard = (s.pos / rate - s.latency_sec).max(0.0);
    s.pos = heard * rate;
    s.playing = false;
    s.latency_sec = 0.0;
    heard
}

pub fn playback_position(state: &NativeAudio) -> serde_json::Value {
    let s = state.inner.lock().unwrap();
    let rate = s.pcm.as_ref().map(|p| p.rate as f64).unwrap_or(44100.0);
    let raw = s.pos / rate;
    serde_json::json!({
        "raw": raw,
        "display": (raw - s.latency_sec).max(0.0),
        "playing": s.playing,
    })
}

#[tauri::command]
pub fn native_play(
    state: State<'_, NativeAudio>,
    from_sec: f64,
    rate: f64,
) -> Result<(), String> {
    start_playback(&state, from_sec, rate)
}

#[tauri::command]
pub fn native_pause(state: State<'_, NativeAudio>) -> f64 {
    pause_playback(&state)
}

#[tauri::command]
pub fn native_position(state: State<'_, NativeAudio>) -> serde_json::Value {
    playback_position(&state)
}

#[tauri::command]
pub fn native_set_ticks(
    state: State<'_, NativeAudio>,
    times: Vec<f64>,
    enabled: bool,
) {
    let mut s = state.inner.lock().unwrap();
    s.ticks = times;
    s.ticks.sort_by(|a, b| a.partial_cmp(b).unwrap());
    s.ticks_enabled = enabled;
    s.ticks_dirty = true;
}

#[tauri::command]
pub fn native_set_volume(state: State<'_, NativeAudio>, volume: f64) {
    state.inner.lock().unwrap().volume = volume.clamp(0.0, 1.0);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plays 1s of silence against the real Pulse server — verifies dlopen,
    /// stream creation, pacing, and position/latency reporting end to end.
    #[test]
    fn silence_roundtrip() {
        if pa().is_none() {
            eprintln!("no pulse — skipping");
            return;
        }
        let na = NativeAudio::new();
        na.set_pcm(44100, 2, vec![0i16; 44100 * 2]); // 1s stereo silence
        start_playback(&na, 0.0, 1.0).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let p = playback_position(&na);
        eprintln!("position after 500ms: {p}");
        assert!(p["playing"].as_bool().unwrap(), "stream died early");
        let raw = p["raw"].as_f64().unwrap();
        assert!(raw > 0.3 && raw < 1.0, "write cursor off: {raw}");
        let heard = pause_playback(&na);
        eprintln!("paused at heard position {heard}");
        assert!(heard > 0.05 && heard <= raw + 1e-9);
    }
}
