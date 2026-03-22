import { useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface UseWhisperRecognitionOptions {
  onResult: (transcript: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
  chunkDuration?: number; // seconds, default 3
}

interface UseWhisperRecognitionReturn {
  start: () => void;
  stop: () => void;
  isSupported: boolean;
}

export function useWhisperRecognition({
  onResult,
  onError,
  chunkDuration = 3,
}: UseWhisperRecognitionOptions): UseWhisperRecognitionReturn {
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<Float32Array[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isProcessingRef = useRef(false);

  const isSupported = typeof navigator !== "undefined" && !!navigator.mediaDevices;

  const processChunk = useCallback(async () => {
    if (isProcessingRef.current || bufferRef.current.length === 0) return;
    isProcessingRef.current = true;

    try {
      // Merge buffer chunks into single Float32Array
      const totalLength = bufferRef.current.reduce((sum, buf) => sum + buf.length, 0);
      const merged = new Float32Array(totalLength);
      let offset = 0;
      for (const buf of bufferRef.current) {
        merged.set(buf, offset);
        offset += buf.length;
      }
      bufferRef.current = [];

      // Downsample to 16kHz if needed
      const sampleRate = contextRef.current?.sampleRate || 44100;
      const pcm16k = sampleRate === 16000 ? merged : downsample(merged, sampleRate, 16000);

      // Skip if too quiet (silence detection)
      const rms = Math.sqrt(pcm16k.reduce((sum, s) => sum + s * s, 0) / pcm16k.length);
      if (rms < 0.01) {
        isProcessingRef.current = false;
        return;
      }

      // Convert Float32 PCM to Int16 bytes, then base64
      const int16 = new Int16Array(pcm16k.length);
      for (let i = 0; i < pcm16k.length; i++) {
        const s = Math.max(-1, Math.min(1, pcm16k[i]));
        int16[i] = s * 32767;
      }
      const bytes = new Uint8Array(int16.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const b64 = btoa(binary);

      const text: string = await invoke("transcribe_audio_b64", {
        pcmB64: b64,
        sampleRate: 16000,
        numSamples: pcm16k.length,
      });

      if (text && text.trim().length > 0) {
        const cleaned = text.trim()
          // whisper sometimes outputs [BLANK_AUDIO] or similar
          .replace(/\[.*?\]/g, "")
          .trim();
        if (cleaned.length > 0) {
          onResult(cleaned, true);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("Model not found") && !msg.includes("whisper-cli not found")) {
        // Don't spam errors for known issues
        onError?.(`認識エラー: ${msg}`);
      } else {
        onError?.(msg);
      }
    }

    isProcessingRef.current = false;
  }, [onResult, onError]);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      mediaStreamRef.current = stream;

      const context = new AudioContext({ sampleRate: 16000 });
      contextRef.current = context;

      const source = context.createMediaStreamSource(stream);

      // Use ScriptProcessorNode to capture raw PCM
      const processor = context.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        bufferRef.current.push(new Float32Array(inputData));
      };

      source.connect(processor);
      processor.connect(context.destination);

      // Process chunks at interval
      intervalRef.current = setInterval(() => {
        processChunk();
      }, chunkDuration * 1000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Permission") || msg.includes("NotAllowed")) {
        onError?.("マイクへのアクセスが拒否されました");
      } else {
        onError?.(`マイク初期化エラー: ${msg}`);
      }
    }
  }, [chunkDuration, processChunk, onError]);

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (contextRef.current) {
      contextRef.current.close();
      contextRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }

    bufferRef.current = [];
    isProcessingRef.current = false;
  }, []);

  return { start, stop, isSupported };
}

function downsample(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return buffer;
  const ratio = fromRate / toRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = Math.round(i * ratio);
    result[i] = buffer[Math.min(srcIndex, buffer.length - 1)];
  }
  return result;
}
