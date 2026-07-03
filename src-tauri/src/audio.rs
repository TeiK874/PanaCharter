//! Audio decoding for the editor (waveform + playback).
//!
//! WebKitGTK's `decodeAudioData` depends on whatever GStreamer plugins happen to be
//! installed, so we decode in-process with symphonia (the same decoder family the ew
//! server uses) and hand the webview raw PCM.

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymErr;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Decode ogg-vorbis / mp3 / wav to interleaved i16 PCM, downmixed to at most two
/// channels (extra channels dropped, matching the server's behavior).
pub fn decode_to_pcm(bytes: Vec<u8>, ext: Option<&str>) -> Result<(u32, u32, Vec<i16>), String> {
    let mss = MediaSourceStream::new(Box::new(std::io::Cursor::new(bytes)), Default::default());
    let mut hint = Hint::new();
    if let Some(e) = ext {
        hint.with_extension(e);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|_| "Could not read audio file (expected ogg vorbis, mp3 or wav)".to_string())?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or("Audio file has no audio track")?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Unsupported audio codec: {e}"))?;

    let mut rate = track.codec_params.sample_rate.unwrap_or(0);
    let mut channels: u32 = 0;
    let mut out: Vec<i16> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // normal end-of-stream conditions
            Err(SymErr::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymErr::ResetRequired) => break,
            Err(e) => return Err(format!("Audio file is corrupt or truncated: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymErr::DecodeError(_)) => continue, // skip damaged frames like the server does
            Err(e) => return Err(format!("Audio decode error: {e}")),
        };
        let spec = *decoded.spec();
        rate = spec.rate;
        let src_channels = spec.channels.count();
        if channels == 0 {
            channels = src_channels.min(2) as u32;
        }
        let mut sample_buf = SampleBuffer::<i16>::new(decoded.capacity() as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);
        let samples = sample_buf.samples();
        if src_channels <= 2 {
            out.extend_from_slice(samples);
        } else {
            for frame in samples.chunks_exact(src_channels) {
                out.push(frame[0]);
                out.push(frame[1]);
            }
        }
    }

    if out.is_empty() {
        return Err("Audio file has no audio data".into());
    }
    if rate == 0 {
        return Err("Audio file has an unknown sample rate".into());
    }
    Ok((rate, channels.max(1), out))
}
