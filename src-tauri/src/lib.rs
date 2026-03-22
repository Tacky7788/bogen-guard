use tauri::{Emitter, Manager};
use tauri::window::Color;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Child};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::io::Write;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

struct AppState {
    server_process: Option<Child>,
    server_port: u16,
    recording: Arc<AtomicBool>,
    recording_thread: Option<std::thread::JoinHandle<()>>,
}

fn get_images_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap().join("images");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

fn get_model_path(model_name: &str) -> PathBuf {
    let filename = match model_name {
        "tiny" => "ggml-tiny.bin",
        "small" => "ggml-small.bin",
        "q5_0" => "ggml-kotoba-v2.2-q5_0.bin",
        "q8_0" => "ggml-kotoba-v2.2-q8_0.bin",
        "large-v3-turbo" => "ggml-large-v3-turbo-q5_0.bin",
        _ => "ggml-kotoba-v2.2-q8_0.bin",
    };
    let exe_path = std::env::current_exe().unwrap_or_default();
    let exe_parent = exe_path.parent().unwrap_or(std::path::Path::new("."));
    for ancestor in exe_parent.ancestors() {
        let model = ancestor.join("models").join(filename);
        if model.exists() {
            return model;
        }
    }
    exe_parent.join("models").join(filename)
}

fn get_whisper_server_path(backend: &str) -> PathBuf {
    let exe_path = std::env::current_exe().unwrap_or_default();
    let exe_dir = exe_path.parent().unwrap_or(std::path::Path::new("."));

    let subdir = match backend {
        "cuda" => "cuda",
        "vulkan" => "vulkan",
        _ => "",
    };

    if !subdir.is_empty() {
        let sub = exe_dir.join(subdir).join("whisper-server.exe");
        if sub.exists() { return sub; }
        for ancestor in exe_dir.ancestors() {
            let bin = ancestor.join("src-tauri").join("binaries").join(subdir).join("whisper-server.exe");
            if bin.exists() { return bin; }
        }
    }

    let sidecar = exe_dir.join("whisper-server.exe");
    if sidecar.exists() { return sidecar; }
    for ancestor in exe_dir.ancestors() {
        let bin = ancestor.join("src-tauri").join("binaries").join("whisper-server.exe");
        if bin.exists() { return bin; }
    }
    sidecar
}

#[tauri::command]
fn list_models() -> Vec<serde_json::Value> {
    let exe_path = std::env::current_exe().unwrap_or_default();
    let exe_parent = exe_path.parent().unwrap_or(std::path::Path::new("."));

    let local_models = vec![
        ("tiny", "Whisper Tiny (75MB)", "ggml-tiny.bin"),
        ("small", "Whisper Small (466MB)", "ggml-small.bin"),
        ("large-v3-turbo", "Large V3 Turbo (547MB)", "ggml-large-v3-turbo-q5_0.bin"),
        ("q5_0", "Kotoba Q5_0 (538MB)", "ggml-kotoba-v2.2-q5_0.bin"),
        ("q8_0", "Kotoba Q8_0 (818MB)", "ggml-kotoba-v2.2-q8_0.bin"),
    ];

    let mut result = vec![
        serde_json::json!({
            "id": "web-speech",
            "label": "Web Speech API (クラウド)",
            "available": true
        })
    ];

    for (id, label, filename) in &local_models {
        let mut available = false;
        for ancestor in exe_parent.ancestors() {
            if ancestor.join("models").join(filename).exists() {
                available = true;
                break;
            }
        }
        result.push(serde_json::json!({
            "id": id,
            "label": label,
            "available": available
        }));
    }

    result
}

#[tauri::command]
fn start_whisper_server(state: tauri::State<'_, Mutex<AppState>>, model: Option<String>, backend: Option<String>, prompt: Option<String>) -> Result<String, String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;

    if let Some(mut child) = st.server_process.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    let model_id = model.unwrap_or_else(|| "q8_0".to_string());
    let backend_id = backend.unwrap_or_else(|| "cpu".to_string());

    // Store for whisper-cli usage
    *WHISPER_BACKEND.lock().unwrap() = backend_id.clone();
    *WHISPER_MODEL.lock().unwrap() = model_id.clone();
    if let Some(ref p) = prompt {
        *WHISPER_PROMPT.lock().unwrap() = p.clone();
    }

    let model_path = get_model_path(&model_id);
    if !model_path.exists() {
        return Err(format!("Model not found: {}", model_path.display()));
    }

    Ok(format!("Configured: {} / {}", model_id, backend_id))
}

#[tauri::command]
fn stop_whisper_server(state: tauri::State<'_, Mutex<AppState>>) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = st.server_process.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
fn start_recording(app: tauri::AppHandle, state: tauri::State<'_, Mutex<AppState>>, chunk_duration_ms: u64) -> Result<(), String> {
    let recording = {
        let mut st = state.lock().map_err(|e| e.to_string())?;
        if st.recording.load(Ordering::SeqCst) {
            return Ok(());
        }
        if let Some(handle) = st.recording_thread.take() {
            st.recording.store(false, Ordering::SeqCst);
            let _ = handle.join();
        }
        st.recording.clone()
    };

    recording.store(true, Ordering::SeqCst);

    let port = {
        let st = state.lock().map_err(|e| e.to_string())?;
        st.server_port
    };

    let app_handle = app.clone();

    let handle = std::thread::spawn(move || {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => {
                let _ = app_handle.emit("transcription-error", "マイクが見つかりません");
                return;
            }
        };

        let default_config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                let _ = app_handle.emit("transcription-error", format!("マイク設定取得エラー: {}", e));
                return;
            }
        };

        let sample_rate = default_config.sample_rate().0;
        let channels = default_config.channels();
        let sample_format = default_config.sample_format();

        let config = cpal::StreamConfig {
            channels,
            sample_rate: default_config.sample_rate(),
            buffer_size: cpal::BufferSize::Default,
        };

        let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let buffer_clone = buffer.clone();
        let recording_clone = recording.clone();
        let ch = channels as usize;

        fn push_mono(buf: &mut Vec<f32>, samples: &[f32], ch: usize) {
            if ch > 1 {
                for chunk in samples.chunks(ch) {
                    let mono = chunk.iter().sum::<f32>() / ch as f32;
                    buf.push(mono);
                }
            } else {
                buf.extend_from_slice(samples);
            }
        }

        let stream = match sample_format {
            cpal::SampleFormat::F32 => {
                let buf_c = buffer_clone.clone();
                let rec_c = recording_clone.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        if !rec_c.load(Ordering::SeqCst) { return; }
                        let mut buf = buf_c.lock().unwrap();
                        push_mono(&mut buf, data, ch);
                    },
                    |_err| {},
                    None,
                )
            },
            cpal::SampleFormat::I16 => {
                let buf_c = buffer_clone.clone();
                let rec_c = recording_clone.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        if !rec_c.load(Ordering::SeqCst) { return; }
                        let converted: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                        let mut buf = buf_c.lock().unwrap();
                        push_mono(&mut buf, &converted, ch);
                    },
                    |_err| {},
                    None,
                )
            },
            cpal::SampleFormat::U16 => {
                let buf_c = buffer_clone.clone();
                let rec_c = recording_clone.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        if !rec_c.load(Ordering::SeqCst) { return; }
                        let converted: Vec<f32> = data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect();
                        let mut buf = buf_c.lock().unwrap();
                        push_mono(&mut buf, &converted, ch);
                    },
                    |_err| {},
                    None,
                )
            },
            _ => {
                let buf_c = buffer_clone.clone();
                let rec_c = recording_clone.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        if !rec_c.load(Ordering::SeqCst) { return; }
                        let mut buf = buf_c.lock().unwrap();
                        push_mono(&mut buf, data, ch);
                    },
                    |_err| {},
                    None,
                )
            },
        };

        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                let _ = app_handle.emit("transcription-error", format!("マイク初期化エラー: {}", e));
                return;
            }
        };

        if let Err(e) = stream.play() {
            let _ = app_handle.emit("transcription-error", format!("録音開始エラー: {}", e));
            return;
        }

        // VAD parameters
        let poll_ms = 50u64;
        let voice_threshold = 0.008f32;
        let silence_timeout_ms = 400u64;
        let min_chunk_ms = 200u64;
        let max_chunk_ms = 3000u64;
        let samples_per_poll = (sample_rate as u64 * poll_ms / 1000) as usize;

        let mut voice_buffer: Vec<f32> = Vec::new();
        let mut is_speaking = false;
        let mut silence_counter = 0u64;

        while recording.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(poll_ms));

            let poll_data: Vec<f32> = {
                let mut buf = buffer.lock().unwrap();
                if buf.len() < samples_per_poll {
                    continue;
                }
                buf.drain(..).collect()
            };

            // Downsample to 16kHz
            let poll_16k = if sample_rate != 16000 {
                downsample(&poll_data, sample_rate, 16000)
            } else {
                poll_data
            };

            let rms = if poll_16k.is_empty() { 0.0 } else {
                (poll_16k.iter().map(|s| s * s).sum::<f32>() / poll_16k.len() as f32).sqrt()
            };

            if rms >= voice_threshold {
                if !is_speaking {
                    is_speaking = true;
                }
                silence_counter = 0;
                voice_buffer.extend_from_slice(&poll_16k);

                // Force send if too long
                let duration_ms = voice_buffer.len() as u64 * 1000 / 16000;
                if duration_ms >= max_chunk_ms {
                    let chunk = std::mem::take(&mut voice_buffer);
                    process_and_send(&chunk, &app_handle);
                }
            } else if is_speaking {
                voice_buffer.extend_from_slice(&poll_16k);
                silence_counter += poll_ms;

                if silence_counter >= silence_timeout_ms {
                    let duration_ms = voice_buffer.len() as u64 * 1000 / 16000;

                    if duration_ms >= min_chunk_ms {
                        let chunk = std::mem::take(&mut voice_buffer);
                        process_and_send(&chunk, &app_handle);
                    } else {
                        voice_buffer.clear();
                    }

                    is_speaking = false;
                    silence_counter = 0;
                }
            }
        }

        drop(stream);
    });

    {
        let mut st = state.lock().map_err(|e| e.to_string())?;
        st.recording_thread = Some(handle);
    }

    Ok(())
}

#[tauri::command]
fn stop_recording(state: tauri::State<'_, Mutex<AppState>>) -> Result<(), String> {
    let handle = {
        let mut st = state.lock().map_err(|e| e.to_string())?;
        st.recording.store(false, Ordering::SeqCst);
        st.recording_thread.take()
    };
    if let Some(h) = handle {
        let _ = h.join();
    }
    Ok(())
}

fn send_to_whisper_server(wav_data: &[u8], port: u16) -> Result<String, String> {
    use std::net::TcpStream;
    use std::io::Read;

    let boundary = "----BogenGuardBoundary";
    let mut body = Vec::new();

    write!(body, "--{}\r\n", boundary).unwrap();
    write!(body, "Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n").unwrap();
    write!(body, "Content-Type: audio/wav\r\n\r\n").unwrap();
    body.extend_from_slice(wav_data);
    write!(body, "\r\n--{}--\r\n", boundary).unwrap();

    let request = format!(
        "POST /inference HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: multipart/form-data; boundary={}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        port, boundary, body.len()
    );

    let mut stream = TcpStream::connect(format!("127.0.0.1:{}", port))
        .map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(30))).ok();

    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    stream.write_all(&body).map_err(|e| e.to_string())?;

    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|e| e.to_string())?;

    if let Some(text_start) = response.find("\"text\"") {
        let after = &response[text_start..];
        if let Some(colon) = after.find(':') {
            let value_part = after[colon + 1..].trim();
            if value_part.starts_with('"') {
                let inner = &value_part[1..];
                if let Some(end_quote) = inner.find('"') {
                    let text = &inner[..end_quote];
                    let cleaned = text.trim()
                        .replace("\\n", " ")
                        .replace("[BLANK_AUDIO]", "")
                        .trim()
                        .to_string();
                    if !cleaned.is_empty() {
                        return Ok(cleaned);
                    }
                }
            }
        }
    }

    Ok(String::new())
}

fn process_and_send(chunk: &[f32], app: &tauri::AppHandle) {
    let t0 = std::time::Instant::now();

    let wav_data = match create_wav_bytes(chunk, 16000) {
        Ok(d) => d,
        Err(_) => return,
    };

    let text = match run_whisper_cli(&wav_data, app) {
        Ok(t) => t,
        Err(_) => return,
    };

    let _elapsed = t0.elapsed();

    if !text.is_empty() {
        let _ = app.emit("transcription-result", text);
    }
}

fn get_models_dir() -> PathBuf {
    let exe_path = std::env::current_exe().unwrap_or_default();
    let exe_parent = exe_path.parent().unwrap_or(std::path::Path::new("."));
    for ancestor in exe_parent.ancestors() {
        let dir = ancestor.join("models");
        if dir.exists() {
            return dir;
        }
    }
    let dir = exe_parent.join("models");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn get_model_url(model_id: &str) -> Option<&'static str> {
    match model_id {
        "tiny" => Some("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"),
        "small" => Some("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"),
        "large-v3-turbo" => Some("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"),
        "q5_0" => Some("https://huggingface.co/Pomni/kotoba-whisper-v2.2-ggml-allquants/resolve/main/ggml-kotoba-v2.2-q5_0.bin"),
        "q8_0" => Some("https://huggingface.co/Pomni/kotoba-whisper-v2.2-ggml-allquants/resolve/main/ggml-kotoba-v2.2-q8_0.bin"),
        _ => None,
    }
}

fn get_model_filename(model_id: &str) -> &'static str {
    match model_id {
        "tiny" => "ggml-tiny.bin",
        "small" => "ggml-small.bin",
        "large-v3-turbo" => "ggml-large-v3-turbo-q5_0.bin",
        "q5_0" => "ggml-kotoba-v2.2-q5_0.bin",
        "q8_0" => "ggml-kotoba-v2.2-q8_0.bin",
        _ => "ggml-tiny.bin",
    }
}

#[tauri::command]
fn download_model(app: tauri::AppHandle, model_id: String) -> Result<String, String> {
    let url = get_model_url(&model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;

    let models_dir = get_models_dir();
    let filename = get_model_filename(&model_id);
    let dest = models_dir.join(filename);

    if dest.exists() {
        return Ok("already exists".to_string());
    }

    let _ = app.emit("download-progress", serde_json::json!({
        "model": model_id,
        "status": "downloading",
        "progress": 0
    }));

    let response = ureq::get(url)
        .call()
        .map_err(|e| format!("Download error: {}", e))?;

    let total_size = response.header("content-length")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    use std::io::{Read, Write};
    let mut reader = response.into_reader();
    let tmp_path = dest.with_extension("bin.tmp");
    let mut file = fs::File::create(&tmp_path)
        .map_err(|e| format!("File create error: {}", e))?;

    let mut downloaded = 0u64;
    let mut buf = vec![0u8; 65536];
    let mut last_progress = 0u8;

    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Read error: {}", e))?;
        if n == 0 { break; }
        file.write_all(&buf[..n]).map_err(|e| format!("Write error: {}", e))?;
        downloaded += n as u64;

        if total_size > 0 {
            let progress = (downloaded * 100 / total_size) as u8;
            if progress != last_progress {
                last_progress = progress;
                let _ = app.emit("download-progress", serde_json::json!({
                    "model": model_id,
                    "status": "downloading",
                    "progress": progress
                }));
            }
        }
    }

    // Rename tmp to final
    fs::rename(&tmp_path, &dest).map_err(|e| format!("Rename error: {}", e))?;

    let _ = app.emit("download-progress", serde_json::json!({
        "model": model_id,
        "status": "done",
        "progress": 100
    }));

    Ok("downloaded".to_string())
}

#[tauri::command]
fn is_model_downloaded(model_id: String) -> bool {
    if model_id == "web-speech" { return true; }
    let models_dir = get_models_dir();
    let filename = get_model_filename(&model_id);
    models_dir.join(filename).exists()
}

fn get_whisper_cli_path(backend: &str) -> PathBuf {
    let exe_path = std::env::current_exe().unwrap_or_default();
    let exe_dir = exe_path.parent().unwrap_or(std::path::Path::new("."));

    let subdir = match backend {
        "cuda" => "cuda",
        "vulkan" => "vulkan",
        _ => "",
    };

    // Check GPU subdirs first
    if !subdir.is_empty() {
        // Next to exe (installed or dev)
        let sub = exe_dir.join(subdir).join("whisper-cli.exe");
        if sub.exists() { return sub; }
        // Dev: src-tauri/binaries/
        for ancestor in exe_dir.ancestors() {
            let bin = ancestor.join("src-tauri").join("binaries").join(subdir).join("whisper-cli.exe");
            if bin.exists() { return bin; }
        }
    }

    // CPU version: bundled as resource (next to exe)
    let names = [
        "whisper-cli-x86_64-pc-windows-msvc.exe",
        "whisper-cli.exe",
    ];
    for name in &names {
        let p = exe_dir.join(name);
        if p.exists() { return p; }
    }

    // Dev: src-tauri/binaries/
    for ancestor in exe_dir.ancestors() {
        for name in &names {
            let bin = ancestor.join("src-tauri").join("binaries").join(name);
            if bin.exists() { return bin; }
        }
    }

    exe_dir.join("whisper-cli.exe")
}

// Store backend/model/prompt in a static for the recording thread
static WHISPER_BACKEND: Mutex<String> = Mutex::new(String::new());
static WHISPER_MODEL: Mutex<String> = Mutex::new(String::new());
static WHISPER_PROMPT: Mutex<String> = Mutex::new(String::new());

fn run_whisper_cli(wav_data: &[u8], _app: &tauri::AppHandle) -> Result<String, String> {
    let backend = WHISPER_BACKEND.lock().map_err(|e| e.to_string())?.clone();
    let model_id = WHISPER_MODEL.lock().map_err(|e| e.to_string())?.clone();
    let prompt = WHISPER_PROMPT.lock().map_err(|e| e.to_string())?.clone();

    let cli_path = get_whisper_cli_path(&backend);
    if !cli_path.exists() {
        return Err(format!("whisper-cli not found: {}", cli_path.display()));
    }

    let model_path = get_model_path(&model_id);
    if !model_path.exists() {
        return Err(format!("Model not found: {}", model_path.display()));
    }

    // Write WAV to temp file
    let wav_path = std::env::temp_dir().join("bogen-guard-chunk.wav");
    fs::write(&wav_path, wav_data).map_err(|e| format!("WAV write: {}", e))?;

    let cli_dir = cli_path.parent().unwrap_or(std::path::Path::new("."));
    let mut cmd = Command::new(&cli_path);
    cmd.current_dir(cli_dir)
        .arg("-m").arg(&model_path)
        .arg("-f").arg(&wav_path)
        .arg("-l").arg("ja")
        .arg("--no-timestamps")
        .arg("-t").arg("4");

    if !prompt.is_empty() {
        cmd.arg("--prompt").arg(&prompt);
    }

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| format!("exec: {}", e))?;

    let _ = fs::remove_file(&wav_path);

    if !output.status.success() {
        return Ok(String::new());
    }

    let text = String::from_utf8_lossy(&output.stdout)
        .trim()
        .replace("[BLANK_AUDIO]", "")
        .trim()
        .to_string();

    // Filter out non-Japanese output (Latin characters only = probably wrong language)
    let has_japanese = text.chars().any(|c| {
        ('\u{3040}'..='\u{309F}').contains(&c) ||  // hiragana
        ('\u{30A0}'..='\u{30FF}').contains(&c) ||  // katakana
        ('\u{4E00}'..='\u{9FFF}').contains(&c)     // kanji
    });

    if !has_japanese && !text.is_empty() {
        return Ok(String::new());
    }

    Ok(text)
}

fn send_to_whisper_ureq(wav_data: &[u8], port: u16) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{}/inference", port);
    let boundary = "----BogenBoundary7ma4d";

    let mut body = Vec::new();
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n");
    body.extend_from_slice(b"Content-Type: audio/wav\r\n\r\n");
    body.extend_from_slice(wav_data);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());

    let content_type = format!("multipart/form-data; boundary={}", boundary);

    let response = ureq::post(&url)
        .set("Content-Type", &content_type)
        .send_bytes(&body)
        .map_err(|e| format!("HTTP error: {}", e))?;

    let resp_body = response.into_string().map_err(|e| format!("Read error: {}", e))?;

    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&resp_body) {
        if let Some(text) = json["text"].as_str() {
            let cleaned = text.trim()
                .replace("[BLANK_AUDIO]", "")
                .trim()
                .to_string();

            let has_japanese = cleaned.chars().any(|c| {
                ('\u{3040}'..='\u{309F}').contains(&c) ||
                ('\u{30A0}'..='\u{30FF}').contains(&c) ||
                ('\u{4E00}'..='\u{9FFF}').contains(&c)
            });

            if has_japanese || cleaned.is_empty() {
                return Ok(cleaned);
            }
            return Ok(String::new());
        }
    }

    Ok(String::new())
}

fn downsample(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate { return input.to_vec(); }
    let ratio = from_rate as f64 / to_rate as f64;
    let new_len = (input.len() as f64 / ratio) as usize;
    let mut output = Vec::with_capacity(new_len);
    for i in 0..new_len {
        let src_idx = (i as f64 * ratio) as usize;
        output.push(input[src_idx.min(input.len() - 1)]);
    }
    output
}

fn create_wav_bytes(pcm: &[f32], sample_rate: u32) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut buf = Vec::new();
    let num_samples = pcm.len() as u32;
    let channels: u16 = 1;
    let bits_per_sample: u16 = 16;
    let byte_rate = sample_rate * channels as u32 * bits_per_sample as u32 / 8;
    let block_align = channels * bits_per_sample / 8;
    let data_size = num_samples * bits_per_sample as u32 / 8;

    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_size).to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&block_align.to_le_bytes());
    buf.extend_from_slice(&bits_per_sample.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_size.to_le_bytes());

    for &sample in pcm {
        let clamped = sample.max(-1.0).min(1.0);
        let i16_sample = (clamped * 32767.0) as i16;
        buf.extend_from_slice(&i16_sample.to_le_bytes());
    }

    Ok(buf)
}

// Image management
#[tauri::command]
fn save_image(app: tauri::AppHandle, name: String, data: Vec<u8>) -> Result<String, String> {
    let dir = get_images_dir(&app);
    let path = dir.join(&name);
    fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn list_images(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = get_images_dir(&app);
    let mut images = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                let ext = ext.to_string_lossy().to_lowercase();
                if ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].contains(&ext.as_str()) {
                    images.push(path.to_string_lossy().to_string());
                }
            }
        }
    }
    Ok(images)
}

#[tauri::command]
fn delete_image(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = get_images_dir(&app);
    let file_path = PathBuf::from(&path);
    if file_path.starts_with(&dir) {
        fs::remove_file(&file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn read_image_base64(path: String) -> Result<String, String> {
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    let ext = PathBuf::from(&path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .to_string();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
fn copy_image_from_path(app: tauri::AppHandle, source: String) -> Result<String, String> {
    let source_path = PathBuf::from(&source);
    if !source_path.exists() {
        return Err("File not found".to_string());
    }
    let name = source_path.file_name()
        .ok_or("Invalid filename")?
        .to_string_lossy()
        .to_string();
    let dir = get_images_dir(&app);
    let dest = dir.join(&name);
    fs::copy(&source_path, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

// Overlay
#[derive(Clone, serde::Serialize)]
struct OverlayPayload {
    image: String,
    size: f64,
    duration: f64,
}

#[tauri::command]
fn show_overlay(app: tauri::AppHandle, image: String, size: f64, duration: f64) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.emit("show-image", OverlayPayload { image, size, duration });
        let _ = overlay.show();
    }
}

#[tauri::command]
fn hide_overlay(app: tauri::AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.emit("hide-image", ());
        let overlay_clone = overlay.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let _ = overlay_clone.hide();
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(AppState {
            server_process: None,
            server_port: 8178,
            recording: Arc::new(AtomicBool::new(false)),
            recording_thread: None,
        }))
        .invoke_handler(tauri::generate_handler![
            show_overlay,
            hide_overlay,
            save_image,
            list_images,
            delete_image,
            read_image_base64,
            copy_image_from_path,
            start_whisper_server,
            stop_whisper_server,
            start_recording,
            stop_recording,
            list_models,
            download_model,
            is_model_downloaded
        ])
        .setup(|app| {
            if let Some(overlay) = app.get_webview_window("overlay") {
                let _ = overlay.set_background_color(Some(Color(0, 0, 0, 0)));
                let _ = overlay.set_ignore_cursor_events(true);
                let _ = overlay.show();
                let overlay_clone = overlay.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    let _ = overlay_clone.hide();
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
