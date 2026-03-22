import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSpeechRecognition } from "./hooks/useSpeechRecognition";
import { listen } from "@tauri-apps/api/event";
import {
  checkProfanity,
  countProfanity,
  getDefaultWords,
  getCustomWords,
  saveCustomWords,
  getDisabledWords,
  saveDisabledWords,
  getAllActiveWords,
  getHiraganaMode,
  setHiraganaMode,
} from "./utils/profanityDetector";
import "./App.css";

const ACCEPTED_FORMATS = "image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml";

interface LogEntry {
  id: number;
  text: string;
  detected: boolean;
  timestamp: string;
}

function App() {
  const [isRunning, setIsRunning] = useState(false);
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  const [imageThumbs, setImageThumbs] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showNgSettings, setShowNgSettings] = useState(false);
  const [customWords, setCustomWords] = useState<string[]>(getCustomWords());
  const [disabledWords, setDisabledWords] = useState<string[]>(getDisabledWords());
  const [newWord, setNewWord] = useState("");
  const [hiraganaMode, setHiraganaModeState] = useState(getHiraganaMode());
  const [displayDuration, setDisplayDuration] = useState(() => {
    const saved = localStorage.getItem("bogen-guard-duration");
    return saved ? Number(saved) : 3;
  });
  const [selectedModel, setSelectedModel] = useState(() => {
    return localStorage.getItem("bogen-guard-model") || "web-speech";
  });
  const [models, setModels] = useState<{ id: string; label: string; available: boolean }[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<{ model: string; progress: number; status: string } | null>(null);
  const [backend, setBackend] = useState(() => {
    return localStorage.getItem("bogen-guard-backend") || "cpu";
  });
  const [imageSize, setImageSize] = useState(() => {
    const saved = localStorage.getItem("bogen-guard-image-size");
    return saved ? Number(saved) : 40;
  });
  const logIdRef = useRef(0);
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTriggerTimeRef = useRef(0);

  const detectedCount = useMemo(
    () => logs.filter((l) => l.detected).length,
    [logs]
  );

  const thumbCacheRef = useRef<Record<string, string>>({});

  const loadImages = useCallback(async () => {
    try {
      const paths: string[] = await invoke("list_images");
      const cache = thumbCacheRef.current;
      const newPaths = paths.filter((p) => !cache[p]);
      for (const p of newPaths) {
        try {
          const b64: string = await invoke("read_image_base64", { path: p });
          cache[p] = b64;
        } catch { /* skip */ }
      }
      for (const key of Object.keys(cache)) {
        if (!paths.includes(key)) delete cache[key];
      }
      thumbCacheRef.current = { ...cache };
      setImagePaths(paths);
      setImageThumbs({ ...cache });
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadImages();
    invoke("list_models").then((m) => setModels(m as typeof models)).catch(() => {});
  }, [loadImages]);

  // Tauri file drop support
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unsub = await listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
          const paths = event.payload.paths || [];
          const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];
          for (const p of paths) {
            const lower = p.toLowerCase();
            if (imageExts.some((ext) => lower.endsWith(ext))) {
              try {
                await invoke("copy_image_from_path", { source: p });
              } catch { /* skip */ }
            }
          }
          await loadImages();
        });
        unlisten = unsub;
      } catch { /* ignore */ }
    })();
    return () => { unlisten?.(); };
  }, [loadImages]);

  const addLog = useCallback((text: string, detected: boolean) => {
    const now = new Date();
    const timestamp = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
    setLogs((prev) => [{ id: ++logIdRef.current, text, detected, timestamp }, ...prev].slice(0, 50));
  }, []);

  const triggerOverlay = useCallback(async () => {
    if (imagePaths.length === 0) return;

    // Cooldown: prevent accidental double trigger
    const now = Date.now();
    if (now - lastTriggerTimeRef.current < 100) return;
    lastTriggerTimeRef.current = now;

    const randomPath = imagePaths[Math.floor(Math.random() * imagePaths.length)];

    try {
      const b64: string = await invoke("read_image_base64", { path: randomPath });
      await invoke("show_overlay", { image: b64, size: imageSize, duration: displayDuration });

      // Set hide timer (resets on each trigger, so last one wins)
      if (overlayTimerRef.current) {
        clearTimeout(overlayTimerRef.current);
      }
      overlayTimerRef.current = setTimeout(async () => {
        await invoke("hide_overlay");
        overlayTimerRef.current = null;
      }, displayDuration * 1000 + 400);
    } catch (e) {
      console.error("overlay error:", e);
    }
  }, [imagePaths, displayDuration, imageSize]);

  const isWebSpeech = selectedModel === "web-speech";
  const handleResult = useCallback(
    (transcript: string, isFinal: boolean) => {
      const result = checkProfanity(transcript);

      if (isFinal || !isWebSpeech) {
        // Final result or Whisper (always final)
        addLog(transcript, result.detected);
        if (result.detected) {
          const count = Math.max(1, countProfanity(transcript));
          for (let i = 0; i < count; i++) {
            setTimeout(() => triggerOverlay(), i * 200);
          }
        }
      }
    },
    [addLog, triggerOverlay, isWebSpeech]
  );

  const handleError = useCallback((msg: string) => setError(msg), []);

  const webSpeech = useSpeechRecognition({
    onResult: handleResult,
    onError: handleError,
  });

  // Listen for Rust-side transcription results
  useEffect(() => {
    const unlistenDl = listen<{ model: string; progress: number; status: string }>("download-progress", (event) => {
      setDownloadProgress(event.payload);
      if (event.payload.status === "done") {
        invoke("list_models").then((m) => setModels(m as typeof models)).catch(() => {});
        setTimeout(() => setDownloadProgress(null), 2000);
      }
    });
    const unlistenResult = listen<string>("transcription-result", (event) => {
      handleResult(event.payload, true);
    });
    const unlistenError = listen<string>("transcription-error", (event) => {
      handleError(event.payload);
    });
    return () => {
      unlistenDl.then((fn) => fn());
      unlistenResult.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [handleResult, handleError]);

  const isSupported = true;

  const [isLoading, setIsLoading] = useState(false);

  const handleToggle = async () => {
    if (isRunning) {
      setIsRunning(false);
      if (isWebSpeech) {
        webSpeech.stop();
      } else {
        invoke("stop_recording").catch(() => {});
        invoke("stop_whisper_server").catch(() => {});
      }
      invoke("hide_overlay").catch(() => {});
      if (overlayTimerRef.current) {
        clearTimeout(overlayTimerRef.current);
        overlayTimerRef.current = null;
      }
    } else {
      setError(null);
      setIsLoading(true);
      try {
        if (isWebSpeech) {
          webSpeech.start();
        } else {
          // Build prompt from active NG words for better detection
          const ngWords = getAllActiveWords();
          const uniqueWords = [...new Set(ngWords)].slice(0, 30);
          const wordList = uniqueWords.join("、");
          const prompt = `ゲーム中の暴言を検知しています。以下の言葉に注意: ${wordList}。${wordList}。`;
          await invoke("start_whisper_server", { model: selectedModel, backend, prompt });
          await invoke("start_recording", { chunkDurationMs: 2000 });
        }
        setIsRunning(true);
      } catch (e) {
        setError(`起動エラー: ${e}`);
      }
      setIsLoading(false);
    }
  };

  const addImage = async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const data = Array.from(new Uint8Array(arrayBuffer));
      await invoke("save_image", { name: file.name, data });
      await loadImages();
    } catch {
      setError("画像の保存に失敗しました");
    }
  };

  const removeImage = async (index: number) => {
    const path = imagePaths[index];
    if (!path) return;
    try {
      await invoke("delete_image", { path });
      await loadImages();
    } catch {
      setError("画像の削除に失敗しました");
    }
  };

  const handleImageDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) addImage(files[i]);
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) addImage(files[i]);
    e.target.value = "";
  };

  const addCustomWord = () => {
    const word = newWord.trim();
    if (!word || customWords.includes(word)) return;
    const next = [...customWords, word];
    setCustomWords(next);
    saveCustomWords(next);
    setNewWord("");
  };

  const removeCustomWord = (word: string) => {
    const next = customWords.filter((w) => w !== word);
    setCustomWords(next);
    saveCustomWords(next);
  };

  const toggleDefaultWord = (word: string) => {
    const isDisabled = disabledWords.includes(word);
    const next = isDisabled
      ? disabledWords.filter((w) => w !== word)
      : [...disabledWords, word];
    setDisabledWords(next);
    saveDisabledWords(next);
  };

  return (
    <div className="app">
      <div className="app-bg">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
      </div>

      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <div className="app-logo">&#x26A1;</div>
          <h1>Bogen Guard</h1>
        </div>
        <span className={`status-badge ${isRunning ? "running" : "stopped"}`}>
          {isRunning ? "監視中" : "停止中"}
        </span>
      </header>

      <main className="app-main">
        {!isSupported && (
          <div className="alert alert-warn">Web Speech API に非対応</div>
        )}
        {error && <div className="alert alert-error">{error}</div>}

        {/* Power Button */}
        <section className="power-section">
          <div>
            <button
              className={`power-btn ${isRunning ? "active" : ""} ${isLoading ? "loading" : ""}`}
              onClick={handleToggle}
              disabled={!isSupported || isLoading}
              aria-label={isRunning ? "監視停止" : "監視開始"}
            >
              <svg viewBox="0 0 24 24">
                <path d="M12 3v9" strokeLinecap="round" />
                <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64" strokeLinecap="round" />
              </svg>
            </button>
            {isRunning && (
              <div className="waveform">
                <div className="waveform-bar" />
                <div className="waveform-bar" />
                <div className="waveform-bar" />
                <div className="waveform-bar" />
                <div className="waveform-bar" />
              </div>
            )}
          </div>
        </section>

        {/* Stats */}
        {logs.length > 0 && (
          <div className="stats-bar">
            <div className="stat-item total">
              <span className="stat-dot" />
              <span className="stat-value">{logs.length}</span>
              <span>認識</span>
            </div>
            <div className={`stat-item ${detectedCount > 0 ? "detected" : ""}`}>
              <span className="stat-dot" />
              <span className="stat-value">{detectedCount}</span>
              <span>検知</span>
            </div>
          </div>
        )}

        {/* Settings Card */}
        <section className="card">
          <div className="section-label">設定</div>

          <div className="setting-row">
            <span className="setting-name">STTモデル</span>
            <div className="setting-control">
              <select
                className="model-select"
                value={selectedModel}
                onChange={(e) => {
                  setSelectedModel(e.target.value);
                  localStorage.setItem("bogen-guard-model", e.target.value);
                }}
                disabled={isRunning}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}{!m.available && m.id !== "web-speech" ? " (未DL)" : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {!isWebSpeech && !models.find(m => m.id === selectedModel)?.available && (
            <div className="download-row">
              {downloadProgress && downloadProgress.model === selectedModel ? (
                <div className="download-progress">
                  <div className="download-bar" style={{ width: `${downloadProgress.progress}%` }} />
                  <span className="download-text">
                    {downloadProgress.status === "done" ? "完了!" : `${downloadProgress.progress}%`}
                  </span>
                </div>
              ) : (
                <button
                  className="btn-download"
                  onClick={() => invoke("download_model", { modelId: selectedModel })}
                  disabled={isRunning}
                >
                  モデルをダウンロード
                </button>
              )}
            </div>
          )}

          {!isWebSpeech && (
            <div className="setting-row">
              <span className="setting-name">処理</span>
              <div className="setting-control">
                <select
                  className="model-select"
                  value={backend}
                  onChange={(e) => {
                    setBackend(e.target.value);
                    localStorage.setItem("bogen-guard-backend", e.target.value);
                  }}
                  disabled={isRunning}
                >
                  <option value="cpu">CPU (BLAS)</option>
                  <option value="vulkan">GPU (Vulkan/AMD)</option>
                  <option value="cuda">GPU (CUDA/NVIDIA)</option>
                </select>
              </div>
            </div>
          )}

          <div className="setting-row">
            <span className="setting-name">表示時間</span>
            <div className="setting-control">
              <input
                type="range" min="1" max="10" step="0.5"
                value={displayDuration}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setDisplayDuration(val);
                  localStorage.setItem("bogen-guard-duration", String(val));
                }}
                className="slider"
              />
              <span className="setting-value">{displayDuration}s</span>
            </div>
          </div>

          <div className="setting-row">
            <span className="setting-name">画像サイズ</span>
            <div className="setting-control">
              <input
                type="range" min="10" max="100" step="5"
                value={imageSize}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setImageSize(val);
                  localStorage.setItem("bogen-guard-image-size", String(val));
                }}
                className="slider"
              />
              <span className="setting-value">{imageSize}%</span>
            </div>
          </div>
        </section>

        {/* NG Words */}
        <section className="card">
          <div className="card-header" onClick={() => setShowNgSettings(!showNgSettings)}>
            <span className="section-label" style={{ marginBottom: 0 }}>NGワード</span>
            <span className={`toggle-icon ${showNgSettings ? "open" : ""}`}>▼</span>
          </div>
          {showNgSettings && (
            <div className="card-body">
              <label className="toggle-row">
                <span className="toggle-label">ひらがな正規化（漢字・カタカナも検知）</span>
                <input
                  type="checkbox"
                  checked={hiraganaMode}
                  onChange={(e) => {
                    setHiraganaModeState(e.target.checked);
                    setHiraganaMode(e.target.checked);
                  }}
                  className="toggle-checkbox"
                />
              </label>

              <div className="ng-add">
                <input
                  type="text"
                  className="ng-input"
                  placeholder="NGワードを追加..."
                  value={newWord}
                  onChange={(e) => setNewWord(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addCustomWord()}
                />
                <button className="btn-add" onClick={addCustomWord}>追加</button>
              </div>

              {customWords.length > 0 && (
                <div>
                  <div className="ng-group-label">カスタム</div>
                  <div className="ng-tags">
                    {customWords.map((word) => (
                      <span key={word} className="ng-tag custom">
                        {word}
                        <button onClick={() => removeCustomWord(word)}>×</button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="ng-group-label">
                  デフォルト
                  <span className="ng-count">{getDefaultWords().length}</span>
                </div>
                <div className="ng-tags">
                  {getDefaultWords().map((word) => (
                    <span
                      key={word}
                      className={`ng-tag default ${disabledWords.includes(word) ? "disabled" : ""}`}
                      onClick={() => toggleDefaultWord(word)}
                    >
                      {word}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Images */}
        <section className="card">
          <div className="section-label">オーバーレイ画像</div>
          <div
            className="drop-zone"
            onDrop={handleImageDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => document.getElementById("image-input")?.click()}
          >
            <p className="placeholder">
              <span className="drop-icon">+</span>
              画像をドロップ or クリック
            </p>
          </div>
          <input
            id="image-input"
            type="file"
            accept={ACCEPTED_FORMATS}
            multiple
            style={{ display: "none" }}
            onChange={handleImageChange}
          />
          {imagePaths.length > 0 && (
            <div className="image-list">
              {imagePaths.map((path, i) => (
                <div key={path} className="image-thumb-wrapper">
                  {imageThumbs[path] ? (
                    <img src={imageThumbs[path]} alt={`overlay-${i}`} className="image-thumb" />
                  ) : (
                    <div className="image-thumb-loading" />
                  )}
                  <button
                    className="image-remove"
                    onClick={(e) => { e.stopPropagation(); removeImage(i); }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Log */}
        <section className="card">
          <div className="section-label">認識ログ</div>
          <div className="log-area">
            {logs.length === 0 ? (
              <p className="log-empty">入力待ち...</p>
            ) : (
              logs.map((entry) => (
                <div
                  key={entry.id}
                  className={`log-entry ${entry.detected ? "detected" : ""}`}
                >
                  <span className="log-time">{entry.timestamp}</span>
                  <span className="log-text">{entry.text}</span>
                  {entry.detected && <span className="log-badge">検知</span>}
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      <div className="notice">
        ※ ゲームはボーダーレスウィンドウで起動してください
      </div>
    </div>
  );
}

export default App;
